import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSkillShareRequest } from '../../shared/agent-skill-sharing-contract'
import { getDefaultSettings } from '../../shared/constants'
import type { DiscoveredSkill } from '../../shared/skills'
import { extractSkillBundleArchive } from '../skills/skill-bundle-extraction'
import { OrcaRuntimeService } from './orca-runtime'

const mocks = vi.hoisted(() => ({ userDataPath: '/tmp' }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => mocks.userDataPath), isPackaged: false }
}))

let testRoot = ''

async function createSkill(id: string, name: string): Promise<DiscoveredSkill> {
  const directoryPath = join(testRoot, 'skills', id)
  await mkdir(directoryPath, { recursive: true })
  await writeFile(
    join(directoryPath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
    'utf8'
  )
  await writeFile(join(directoryPath, 'notes.txt'), name, 'utf8')
  return {
    id,
    name,
    description: `${name} description`,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Shared',
    rootPath: join(testRoot, 'skills'),
    directoryPath,
    skillFilePath: join(directoryPath, 'SKILL.md'),
    installed: true,
    updatedAt: null
  }
}

function request(skillSelectors: string[]): AgentSkillShareRequest {
  return {
    skillSelectors,
    bundleName: 'team-skills',
    releaseNotes: 'Release notes'
  }
}

async function operationDirectories(): Promise<string[]> {
  return readdir(join(testRoot, 'agent-skill-share-operations')).catch(() => [])
}

function runtimeWithCloud(options: {
  isEnabled: () => boolean
  failPublish?: boolean
  waitForAbort?: boolean
}) {
  const manifests: string[][] = []
  let notifyStarted: (() => void) | null = null
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const publishVersion = vi.fn(async (input) => {
    const extractionRoot = join(testRoot, 'extracted')
    await mkdir(extractionRoot, { recursive: true })
    const extracted = await extractSkillBundleArchive({
      archivePath: input.archivePath,
      destinationDirectory: join(extractionRoot, randomUUID()),
      expectedArchiveSha256: input.archiveSha256,
      expectedPackageId: input.packageId
    })
    manifests.push(extracted.manifest.skills.map((skill) => skill.name))
    if (options.failPublish) {
      throw new Error('publish-failed')
    }
    if (options.waitForAbort) {
      notifyStarted?.()
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => reject(new Error('upload-aborted'))
        input.signal?.addEventListener('abort', rejectAbort, { once: true })
        if (input.signal?.aborted) {
          rejectAbort()
        }
      })
    }
    return {
      status: 'ok' as const,
      value: {
        packageId: extracted.manifest.packageId,
        versionId: extracted.manifest.versionId,
        name: extracted.manifest.bundleName,
        description: extracted.manifest.description,
        packageDigest: extracted.manifest.bundleDigest,
        archiveSha256: input.archiveSha256,
        compressedBytes: input.compressedBytes,
        createdAt: extracted.manifest.createdAt,
        releaseNotes: input.releaseNotes,
        manifest: extracted.manifest
      }
    }
  })
  const createShare = vi.fn(async () => ({
    status: 'ok' as const,
    value: { id: 'share-id', url: 'https://share.onorca.dev/skills/share/share-id' }
  }))
  const runtime = new OrcaRuntimeService({
    getSettings: () => ({
      ...getDefaultSettings(testRoot),
      agentSkillSharingEnabled: options.isEnabled()
    })
  } as never)
  runtime.setSkillCloudService({ publishVersion, createShare } as never)
  return { runtime, publishVersion, createShare, manifests, started }
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'orca-agent-skill-share-'))
  mocks.userDataPath = testRoot
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('agent skill sharing runtime', () => {
  it('publishes only the selected discovered skills and cleans preparation files', async () => {
    const alpha = await createSkill('alpha-id', 'alpha')
    const beta = await createSkill('beta-id', 'beta')
    const ignored = await createSkill('ignored-id', 'ignored')
    const staleOperation = join(testRoot, 'agent-skill-share-operations', 'stale-operation')
    await mkdir(staleOperation, { recursive: true })
    await writeFile(join(staleOperation, 'package.tar.gz'), 'crash residue')
    const { runtime, manifests } = runtimeWithCloud({ isEnabled: () => true })

    const result = await runtime.publishDiscoveredSkillsFromAgent(request(['alpha-id', 'beta']), [
      alpha,
      beta,
      ignored
    ])

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        selectedSkills: [
          { id: 'alpha-id', name: 'alpha' },
          { id: 'beta-id', name: 'beta' }
        ]
      }
    })
    expect(manifests).toEqual([['alpha', 'beta']])
    expect(await operationDirectories()).toEqual([])
  })
  it('denies before reading a discovered directory and blocks later publishes when disabled', async () => {
    let enabled = false
    const { runtime, publishVersion } = runtimeWithCloud({ isEnabled: () => enabled })
    const missing = {
      ...(await createSkill('alpha-id', 'alpha')),
      directoryPath: join(testRoot, 'does-not-exist')
    }

    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['alpha-id']), [missing])
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_disabled' })
    expect(publishVersion).not.toHaveBeenCalled()

    enabled = true
    const alpha = await createSkill('alpha-two', 'alpha-two')
    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['alpha-two']), [alpha])
    ).resolves.toMatchObject({ status: 'ok' })
    enabled = false
    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['alpha-two']), [alpha])
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_disabled' })
  })

  it('cleans preparation files after cloud failure', async () => {
    const alpha = await createSkill('alpha-id', 'alpha')
    const { runtime } = runtimeWithCloud({ isEnabled: () => true, failPublish: true })

    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['alpha-id']), [alpha])
    ).rejects.toThrow('publish-failed')
    expect(await operationDirectories()).toEqual([])
  })

  it('returns an actionable error for package-incompatible skill metadata', async () => {
    const invalid = await createSkill('invalid-id', 'invalid_name')
    const { runtime, publishVersion } = runtimeWithCloud({ isEnabled: () => true })

    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['invalid-id']), [invalid])
    ).rejects.toMatchObject({ code: 'agent_skill_not_shareable' })
    expect(publishVersion).not.toHaveBeenCalled()
    expect(await operationDirectories()).toEqual([])
  })

  it('cancels an upload and cleans preparation files', async () => {
    const alpha = await createSkill('alpha-id', 'alpha')
    const controller = new AbortController()
    const { runtime, started } = runtimeWithCloud({
      isEnabled: () => true,
      waitForAbort: true
    })
    const publishing = runtime.publishDiscoveredSkillsFromAgent(
      request(['alpha-id']),
      [alpha],
      controller.signal
    )
    await started
    await expect(
      runtime.publishDiscoveredSkillsFromAgent(request(['alpha-id']), [alpha])
    ).rejects.toMatchObject({ code: 'agent_skill_sharing_busy' })
    controller.abort()

    await expect(publishing).rejects.toThrow('upload-aborted')
    expect(await operationDirectories()).toEqual([])
  })
})
