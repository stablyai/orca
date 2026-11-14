import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillPackageArchive } from '../package-archive/skill-package-creation'
import { executeSkillInstallRequest } from './skill-install-request'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../../shared/skill-package-manifest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-request-test-'))
  roots.push(root)
  const home = join(root, 'home')
  const source = join(root, 'source')
  await Promise.all([mkdir(home), mkdir(source)])
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: request-skill\ndescription: Request test\n---\n\n# Request\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: 'package_1',
    versionId: 'version_1'
  })
  const archiveBytes = await readFile(archive.archivePath)
  return {
    root,
    home,
    archive,
    request: {
      operationId: 'operation_1',
      package: {
        packageId: archive.manifest.packageId,
        versionId: archive.manifest.versionId,
        packageDigest: archive.manifest.packageDigest,
        archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
        compressedBytes: archiveBytes.length
      },
      ingress: {
        kind: 'download-grant' as const,
        url: 'https://storage.test/package.tar.gz',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      destination: { scope: 'global' as const, environmentId: 'environment_1' }
    },
    dependencies: {
      authority: {
        environmentId: 'environment_1',
        homeDirectory: home,
        resolveWorktree: async () => null,
        resolveFolderWorkspace: async () => null
      },
      stateDirectory: join(root, 'state'),
      allowedDownloadOrigins: ['https://storage.test'],
      requireHttps: true,
      fetcher: vi.fn(
        async () =>
          new Response(archiveBytes, {
            headers: { 'content-type': SKILL_PACKAGE_CONTENT_TYPE }
          })
      ) as typeof fetch,
      detectProviders: async () => ['codex']
    }
  }
}

describe('executeSkillInstallRequest', () => {
  it('downloads, verifies, and installs on the destination-owning host', async () => {
    const { root, request, dependencies } = await fixture()
    const result = await executeSkillInstallRequest(request, dependencies)
    expect(result.status).toBe('installed')
    expect(
      await readFile(join(root, 'home', '.agents', 'skills', 'request-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Request')
  })

  it('serializes download and trusted-local requests through one destination transaction', async () => {
    const { root, request, dependencies, archive } = await fixture()
    const [downloaded, local] = await Promise.all([
      executeSkillInstallRequest(request, dependencies),
      executeSkillInstallRequest(
        {
          ...request,
          operationId: 'operation_2',
          ingress: { kind: 'local-file', path: archive.archivePath }
        },
        { ...dependencies, allowTrustedLocalFile: true }
      )
    ])

    expect([downloaded.status, local.status].sort()).toEqual(['installed', 'unchanged'])
    expect(
      await readdir(join(dependencies.stateDirectory, 'skill-installs', 'receipts'))
    ).toHaveLength(1)
    expect(
      (await readdir(join(root, 'home', '.agents', 'skills'))).filter((name) =>
        name.includes('.orca-')
      )
    ).toEqual([])
  })

  it('returns a structured cancelled result without leaving partial ingress bytes', async () => {
    const { request, dependencies } = await fixture()
    const controller = new AbortController()
    controller.abort()

    const result = await executeSkillInstallRequest(request, {
      ...dependencies,
      signal: controller.signal
    })

    expect(result).toMatchObject({
      status: 'cancelled',
      errorCategory: 'skill-download-cancelled',
      failure: { category: 'cancelled', retryable: true }
    })
    const downloads = join(dependencies.stateDirectory, 'skill-installs', 'downloads')
    expect(await readdir(downloads).catch(() => [])).toEqual([])
  })
})
