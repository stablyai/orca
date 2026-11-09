import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillSharePreparationService } from './skill-share-preparation'
import { SkillCloudService } from '../cloud/skill-cloud-package-service'
import { writeSkillInstallReceipt } from '../transaction-state/skill-install-provenance'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const temporaryDirectories: string[] = []

async function nameIsFree() {
  return { status: 'ok' as const, value: null }
}

async function createSource(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-share-preparation-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: retry-skill\ndescription: Retry publication\n---\n\n# Retry\n'
  )
  return { root, source }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('SkillSharePreparationService', () => {
  it('finds Windows install receipts through a provider junction', async () => {
    const { root, source } = await createSource()
    await writeFile(join(source, 'run.sh'), 'echo without shebang\n')
    const canonicalSource = await realpath(source)
    const providerSource = join(root, 'provider-source')
    await symlink(
      canonicalSource,
      providerSource,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const stateDirectory = join(root, 'state')
    await writeSkillInstallReceipt(stateDirectory, {
      schemaVersion: 1,
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      scope: 'global',
      destinationIdentity: 'global:windows',
      canonicalPath: canonicalSource,
      placements: [],
      installedAt: '2026-08-16T12:00:00.000Z',
      hostIdentity: 'windows',
      fileModes: [
        { path: 'SKILL.md', executable: false },
        { path: 'run.sh', executable: true }
      ]
    })
    const service = new SkillSharePreparationService(
      join(root, 'preparations'),
      {
        findOwnedPackageId: nameIsFree,
        publishVersion: vi.fn(),
        shareTarget: vi.fn(),
        shareVersion: vi.fn()
      },
      { installStateDirectory: stateDirectory, platform: 'win32' }
    )

    const prepared = await service.prepare({ sourceDirectory: providerSource })

    expect(prepared.skills?.[0]?.executablePaths).toEqual(['run.sh'])
  })

  it('enforces the preparation cap while archives are still being created', async () => {
    const { root, source } = await createSource()
    const service = new SkillSharePreparationService(join(root, 'preparations'), {
      findOwnedPackageId: nameIsFree,
      publishVersion: vi.fn(),
      shareTarget: vi.fn(),
      shareVersion: vi.fn()
    })

    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => service.prepare({ sourceDirectory: source }))
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: new Error('skill-share-preparation-limit')
    })
  })

  describe('share links', () => {
    type Link = { id: string; packageId: string; pinnedVersionId?: string; live: boolean }

    /** Minimal share routes; `canonical` mirrors a cloud that keeps one link per package. */
    function stubCloud(canonical: boolean): { links: Link[]; requests: string[] } {
      vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'test-token')
      const links: Link[] = []
      const requests: string[] = []
      const capabilities = canonical ? { capabilities: ['share_canonical', 'share_repoint'] } : {}
      const wire = (link: Link) => ({
        id: link.id,
        url: `https://share.onorca.dev/skills/share/${link.id}`,
        pinnedVersionId: link.pinnedVersionId
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL, init?: RequestInit) => {
          const method = init?.method ?? 'GET'
          const rawBody = init?.body ? String(init.body) : ''
          const body = rawBody ? JSON.parse(rawBody) : {}
          requests.push(`${method} ${input.pathname} ${rawBody}`.trim())
          if (method === 'GET') {
            return Response.json({
              shares: links
                .filter((link) => link.live)
                .map((link) => ({
                  ...wire(link),
                  packageId: link.packageId,
                  ...(canonical ? { canonical: true } : {})
                })),
              ...capabilities
            })
          }
          if (method === 'PATCH') {
            const link = links.find(
              (candidate) => `/v1/skill-shares/${candidate.id}` === input.pathname
            )
            if (!link?.live) {
              return Response.json({ code: 'skill_share_not_found' }, { status: 404 })
            }
            link.pinnedVersionId = body.pinnedVersionId
            return Response.json({ share: wire(link) })
          }
          const link: Link = {
            id: `share_${links.length + 1}`,
            packageId: input.pathname.split('/')[3]!,
            pinnedVersionId: body.pinnedVersionId,
            live: true
          }
          links.push(link)
          return Response.json({ share: wire(link), ...capabilities }, { status: 201 })
        })
      )
      return { links, requests }
    }

    async function publishTwice(root: string, source: string, between?: () => void) {
      const api = new SkillCloudService(join(root, 'user-data'))
      const apiUrl = 'http://127.0.0.1:8787'
      let version = 0
      const service = new SkillSharePreparationService(join(root, 'preparations'), {
        findOwnedPackageId: nameIsFree,
        publishVersion: vi.fn(async () => ({
          status: 'ok' as const,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publish reads only the version's package and version ids.
          value: { packageId: 'package_1', versionId: `version_${++version}` } as never
        })),
        shareTarget: (packageId, options) => api.shareTarget(packageId, { ...options, apiUrl }),
        shareVersion: (published, target, options) =>
          api.shareVersion(published, target, { ...options, apiUrl })
      })
      const publish = async (beforePublish?: () => void) => {
        const prepared = await service.prepare({ sourceDirectory: source, packageId: 'package_1' })
        beforePublish?.()
        return service.publish({ preparationId: prepared.preparationId, releaseNotes: '' })
      }
      const first = await publish()
      return { first, second: await publish(between).catch((error: Error) => error) }
    }

    it('updates the same link when the package is shared again', async () => {
      const { root, source } = await createSource()
      const { links, requests } = stubCloud(true)

      const { first, second } = await publishTwice(root, source)

      expect(first).toMatchObject({ status: 'ok', value: { share: { id: 'share_1' } } })
      expect(second).toMatchObject({ status: 'ok', value: { share: { id: 'share_1' } } })
      expect(links).toEqual([
        { id: 'share_1', packageId: 'package_1', pinnedVersionId: 'version_2', live: true }
      ])
      expect(requests).toContain(
        'PATCH /v1/skill-shares/share_1 {"pinnedVersionId":"version_2","expectedVersionId":"version_1"}'
      )
    })

    it('fails instead of making a new link when the updated link was stopped', async () => {
      const { root, source } = await createSource()
      const { links } = stubCloud(true)

      const { second } = await publishTwice(root, source, () => {
        links[0]!.live = false
      })

      expect(second).toEqual(new Error('skill-share-link-changed'))
      expect(links).toHaveLength(1)
    })

    it('keeps one new unpinned link per publish on clouds without canonical links', async () => {
      const { root, source } = await createSource()
      const { links, requests } = stubCloud(false)

      const { second } = await publishTwice(root, source)

      expect(second).toMatchObject({ status: 'ok', value: { share: { id: 'share_2' } } })
      expect(links.map((link) => link.pinnedVersionId)).toEqual([undefined, undefined])
      expect(requests.filter((request) => request.startsWith('POST'))).toEqual([
        'POST /v1/skill-packages/package_1/shares {}',
        'POST /v1/skill-packages/package_1/shares {}'
      ])
    })
  })
})
