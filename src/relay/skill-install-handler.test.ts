import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { createSkillPackageArchive } from '../main/skills/skill-package-creation'
import { createSkillBundleArchive } from '../main/skills/skill-bundle-creation'
import {
  SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD,
  SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD,
  SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD,
  SKILL_SSH_RELAY_INSTALL_METHOD,
  SKILL_SSH_RELAY_LIST_METHOD,
  SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD,
  SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD
} from '../shared/skill-ssh-relay-contract'
import {
  readSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from '../main/skills/skill-install-provenance'
import {
  skillInstallJournalPath,
  type SkillInstallJournalV1
} from '../main/skills/skill-install-recovery'
import { SKILL_RELAY_CAPABILITIES, SkillInstallHandler } from './skill-install-handler'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
  beforeStart?: (input: {
    archive: Awaited<ReturnType<typeof createSkillPackageArchive>>
    home: string
    source: string
    state: string
  }) => Promise<void>,
  options: { detectProviders?: () => Promise<readonly string[]>; recovery?: Promise<unknown> } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-skill-test-'))
  roots.push(root)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const source = join(root, 'source')
  await Promise.all([mkdir(home), mkdir(source)])
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: relay-skill\ndescription: Relay test\n---\n\n# Relay\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: 'package_1',
    versionId: 'version_1'
  })
  await beforeStart?.({ archive, home, source, state })
  const bytes = await readFile(archive.archivePath)
  const handlers = new Map<string, MethodHandler>()
  const dispatcher = {
    onRequest: vi.fn((method: string, handler: MethodHandler) => handlers.set(method, handler))
  } as unknown as RelayDispatcher
  new SkillInstallHandler(dispatcher, {
    homeDirectory: home,
    stateDirectory: state,
    detectProviders: options.detectProviders ?? (async () => []),
    recovery: options.recovery
  })
  const call = (method: string, params: Record<string, unknown>) =>
    handlers.get(method)!(params, {
      clientId: 1,
      isStale: () => false,
      signal: new AbortController().signal
    })
  return { archive, bytes, call, home, root, state }
}

async function initGitWorktree(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: directory, stdio: 'pipe' })
  return realpath(directory)
}

async function installStagedSkill(
  call: (method: string, params: Record<string, unknown>) => unknown,
  archive: Awaited<ReturnType<typeof createSkillPackageArchive>>,
  bytes: Buffer,
  destination: Record<string, unknown>,
  workspace?: Record<string, unknown>
) {
  const packageIdentity = {
    packageId: archive.manifest.packageId,
    versionId: archive.manifest.versionId,
    packageDigest: archive.manifest.packageDigest,
    archiveSha256: archive.archiveSha256,
    compressedBytes: bytes.length
  }
  const begun = (await call(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, {
    package: packageIdentity
  })) as { uploadId: string }
  await call(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, {
    uploadId: begun.uploadId,
    offset: 0,
    bytesBase64: bytes.toString('base64')
  })
  await call(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, { uploadId: begun.uploadId })
  return call(SKILL_SSH_RELAY_INSTALL_METHOD, {
    request: {
      operationId: 'operation_workspace',
      package: packageIdentity,
      ingress: { kind: 'staged-upload', uploadId: begun.uploadId },
      destination
    },
    ...(workspace ? { workspace } : {})
  })
}

describe('SkillInstallHandler', () => {
  it('installs a client-mediated package entirely on the SSH host', async () => {
    const { archive, bytes, call, home } = await fixture()
    const packageIdentity = {
      packageId: archive.manifest.packageId,
      versionId: archive.manifest.versionId,
      packageDigest: archive.manifest.packageDigest,
      archiveSha256: archive.archiveSha256,
      compressedBytes: bytes.length
    }
    const begun = (await call(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, {
      package: packageIdentity
    })) as { uploadId: string }
    await call(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, {
      uploadId: begun.uploadId,
      offset: 0,
      bytesBase64: bytes.toString('base64')
    })
    await call(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, { uploadId: begun.uploadId })

    const result = (await call(SKILL_SSH_RELAY_INSTALL_METHOD, {
      request: {
        operationId: 'operation_1',
        package: packageIdentity,
        ingress: { kind: 'staged-upload', uploadId: begun.uploadId },
        destination: { scope: 'global', executionTarget: { kind: 'host' } }
      }
    })) as { status: string }

    expect(result.status).toBe('installed')
    expect(
      await readFile(join(home, '.agents', 'skills', 'relay-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Relay')
  })

  it('advertises separately gateable install, upload, and management capabilities', () => {
    expect(SKILL_RELAY_CAPABILITIES).toEqual([
      'skills.install.v1',
      'skills.install-providers.v1',
      'skills.install.bundle.v1',
      'skills.preview.bundle.v1',
      'skills.install-progress.v1',
      'skills.upload.v1',
      'skills.manage.v1'
    ])
  })

  it('previews a bundle with one provider detection pass', async () => {
    const detectProviders = vi.fn(async () => [])
    const { call } = await fixture(undefined, { detectProviders })
    const selectedSkills = Array.from({ length: 30 }, (_, index) => ({
      id: `skill-${index}`,
      name: `skill-${index}`,
      digest: String(index).padStart(64, '0')
    }))

    const result = (await call(SKILL_SSH_RELAY_PREVIEW_BUNDLE_METHOD, {
      request: {
        package: {
          packageId: 'package_1',
          versionId: 'version_1',
          bundleDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 100
        },
        selectedSkills,
        destination: { scope: 'global', executionTarget: { kind: 'host' } }
      }
    })) as { skills: unknown[] }

    expect(result.skills).toHaveLength(30)
    expect(detectProviders).toHaveBeenCalledOnce()
  })

  it('continues after transient startup recovery failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recovery = Promise.reject(new Error('transient-recovery-failure'))
    void recovery.catch(() => undefined)
    const { call } = await fixture(undefined, {
      recovery
    })

    await expect(call(SKILL_SSH_RELAY_LIST_METHOD, { workspaces: [] })).resolves.toEqual([])
  })

  it('recovers a committed install before the first managed-install listing', async () => {
    let canonicalPath = ''
    const { archive, call, state } = await fixture(async (input) => {
      canonicalPath = join(input.home, '.agents', 'skills', input.archive.manifest.name)
      await mkdir(canonicalPath, { recursive: true })
      await writeFile(
        join(canonicalPath, 'SKILL.md'),
        await readFile(join(input.source, 'SKILL.md'))
      )
      const receipt: SkillInstallReceiptV1 = {
        schemaVersion: 1,
        packageId: input.archive.manifest.packageId,
        versionId: input.archive.manifest.versionId,
        packageDigest: input.archive.manifest.packageDigest,
        archiveSha256: input.archive.archiveSha256,
        scope: 'global',
        destinationIdentity: 'global:ssh-host',
        canonicalPath,
        placements: [
          {
            provider: 'agent-skills',
            path: canonicalPath,
            topology: 'canonical-copy',
            status: 'installed'
          }
        ],
        installedAt: '2026-08-12T12:00:00.000Z',
        hostIdentity: 'ssh-host',
        fileModes: input.archive.manifest.files
      }
      const extractionPath = join(input.home, '.agents', 'skills', '.orca-skill-extract-crashed')
      const journal: SkillInstallJournalV1 = {
        schemaVersion: 1,
        operation: 'install',
        phase: 'canonical-placed',
        canonicalPath,
        extractionPath,
        stagingPath: join(
          input.home,
          '.agents',
          'skills',
          `.${input.archive.manifest.name}.orca-staging-crashed`
        ),
        backupPath: join(
          input.home,
          '.agents',
          'skills',
          `.${input.archive.manifest.name}.orca-backup-crashed`
        ),
        backupDigest: null,
        stagingFileModes: input.archive.manifest.files,
        backupFileModes: input.archive.manifest.files,
        receipt
      }
      await writeSkillStateFile(
        skillInstallJournalPath(join(input.state, 'skill-installs'), canonicalPath),
        journal
      )
    })

    const installs = (await call(SKILL_SSH_RELAY_LIST_METHOD, { workspaces: [] })) as {
      packageId: string
      versionId: string
      state: string
    }[]

    expect(installs).toEqual([
      expect.objectContaining({
        packageId: archive.manifest.packageId,
        versionId: archive.manifest.versionId,
        state: 'unchanged'
      })
    ])
    await expect(
      readSkillInstallReceipt(join(state, 'skill-installs'), canonicalPath)
    ).resolves.toMatchObject({ versionId: archive.manifest.versionId })
    await expect(
      readFile(skillInstallJournalPath(join(state, 'skill-installs'), canonicalPath))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs a selected bundle through the additive SSH method', async () => {
    const { call, home, root } = await fixture()
    const alpha = join(root, 'alpha-skill')
    const beta = join(root, 'beta-skill')
    await Promise.all([mkdir(alpha), mkdir(beta)])
    await writeFile(join(alpha, 'SKILL.md'), '---\nname: alpha-skill\ndescription: Alpha\n---\n')
    await writeFile(join(beta, 'SKILL.md'), '---\nname: beta-skill\ndescription: Beta\n---\n')
    const bundle = await createSkillBundleArchive({
      sources: [{ sourceDirectory: alpha }, { sourceDirectory: beta }],
      archivePath: join(root, 'bundle.tar.gz'),
      packageId: 'bundle_package',
      versionId: 'bundle_version',
      bundleName: 'relay-bundle'
    })
    const bundleBytes = await readFile(bundle.archivePath)
    const packageIdentity = {
      packageId: bundle.manifest.packageId,
      versionId: bundle.manifest.versionId,
      bundleDigest: bundle.manifest.bundleDigest,
      archiveSha256: bundle.archiveSha256,
      compressedBytes: bundleBytes.length
    }
    const begun = (await call(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, {
      package: packageIdentity
    })) as { uploadId: string }
    await call(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, {
      uploadId: begun.uploadId,
      offset: 0,
      bytesBase64: bundleBytes.toString('base64')
    })
    await call(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, { uploadId: begun.uploadId })
    const alphaId = bundle.manifest.skills.find((skill) => skill.name === 'alpha-skill')!.id

    const result = (await call(SKILL_SSH_RELAY_INSTALL_BUNDLE_METHOD, {
      request: {
        operationId: 'bundle_operation',
        package: packageIdentity,
        selectedSkillIds: [alphaId],
        ingress: { kind: 'staged-upload', uploadId: begun.uploadId },
        destination: { scope: 'global', executionTarget: { kind: 'host' } },
        conflictDecisions: []
      }
    })) as { status: string; skills: { name: string }[] }

    expect(result).toMatchObject({ status: 'complete', skills: [{ name: 'alpha-skill' }] })
    await expect(
      readFile(join(home, '.agents', 'skills', 'alpha-skill', 'SKILL.md'))
    ).resolves.toBeDefined()
    await expect(
      readFile(join(home, '.agents', 'skills', 'beta-skill', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('exposes invalid staged archives through the stable SSH failure contract', async () => {
    const { call } = await fixture()
    const bytes = Buffer.from('not a skill archive')
    const packageIdentity = {
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      compressedBytes: bytes.length
    }
    const begun = (await call(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, {
      package: packageIdentity
    })) as { uploadId: string }
    await call(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, {
      uploadId: begun.uploadId,
      offset: 0,
      bytesBase64: bytes.toString('base64')
    })
    await call(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, { uploadId: begun.uploadId })

    await expect(
      call(SKILL_SSH_RELAY_INSTALL_METHOD, {
        request: {
          operationId: 'operation_invalid',
          package: packageIdentity,
          ingress: { kind: 'staged-upload', uploadId: begun.uploadId },
          destination: { scope: 'global', executionTarget: { kind: 'host' } }
        }
      })
    ).rejects.toMatchObject({
      code: 'skill_install_failure',
      data: { category: 'archive', retryable: false }
    })
  })

  it('rejects a matching workspace id whose client path is outside home', async () => {
    const { archive, bytes, call, home, root } = await fixture()
    const outside = await initGitWorktree(join(root, 'outside'))
    const worktreeId = `repo::${outside}`

    await expect(
      installStagedSkill(
        call,
        archive,
        bytes,
        { scope: 'workspace', worktreeId },
        { kind: 'worktree', id: worktreeId, path: outside }
      )
    ).rejects.toMatchObject({
      code: 'skill_install_failure',
      data: {
        category: 'admission',
        code: expect.stringMatching(/workspace-not-found|destination-escape/)
      }
    })
    await expect(
      readFile(join(outside, '.agents', 'skills', 'relay-skill', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(home, '.agents', 'skills', 'relay-skill', 'SKILL.md'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects installing when the client path is the relay home', async () => {
    const { archive, bytes, call, home } = await fixture()
    execFileSync('git', ['init', '-q'], { cwd: home, stdio: 'pipe' })
    const worktreeId = `repo::${home}`

    await expect(
      installStagedSkill(
        call,
        archive,
        bytes,
        { scope: 'workspace', worktreeId },
        { kind: 'worktree', id: worktreeId, path: home }
      )
    ).rejects.toMatchObject({
      code: 'skill_install_failure',
      data: {
        category: 'admission',
        code: expect.stringMatching(/workspace-not-found|destination-escape/)
      }
    })
  })

  it('rejects an unlisted subdirectory of home even when the workspace id matches', async () => {
    const { archive, bytes, call, home } = await fixture()
    const sshDir = join(home, '.ssh')
    await mkdir(sshDir)
    const worktreeId = `repo::${sshDir}`

    await expect(
      installStagedSkill(
        call,
        archive,
        bytes,
        { scope: 'workspace', worktreeId },
        { kind: 'worktree', id: worktreeId, path: sshDir }
      )
    ).rejects.toMatchObject({
      code: 'skill_install_failure',
      data: {
        category: 'admission',
        code: expect.stringMatching(/workspace-not-found|destination-escape/)
      }
    })
    await expect(
      readFile(join(sshDir, '.agents', 'skills', 'relay-skill', 'SKILL.md'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('installs into a listed git worktree under home', async () => {
    const { archive, bytes, call, home } = await fixture()
    const worktree = await initGitWorktree(join(home, 'repo'))
    const worktreeId = `repo::${worktree}`

    const result = (await installStagedSkill(
      call,
      archive,
      bytes,
      { scope: 'workspace', worktreeId },
      { kind: 'worktree', id: worktreeId, path: worktree }
    )) as { status: string }

    expect(result.status).toBe('installed')
    expect(
      await readFile(join(worktree, '.agents', 'skills', 'relay-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Relay')
  })

  it('installs into a host-listed worktree under home and ignores a client path outside home', async () => {
    const { archive, bytes, call, home, root } = await fixture()
    const worktree = await initGitWorktree(join(home, 'repo'))
    const outside = await initGitWorktree(join(root, 'outside'))

    const result = (await installStagedSkill(
      call,
      archive,
      bytes,
      { scope: 'workspace', worktreeId: `repo::${worktree}` },
      { kind: 'worktree', id: `repo::${worktree}`, path: outside }
    )) as { status: string }

    expect(result.status).toBe('installed')
    expect(
      await readFile(join(worktree, '.agents', 'skills', 'relay-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Relay')
    await expect(
      readFile(join(outside, '.agents', 'skills', 'relay-skill', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs into a folder workspace under home without listing it as a git worktree', async () => {
    const { archive, bytes, call, home } = await fixture()
    const folder = join(home, 'notes')
    await mkdir(folder)
    const folderId = '123e4567-e89b-12d3-a456-426614174000'

    const result = (await installStagedSkill(
      call,
      archive,
      bytes,
      { scope: 'workspace', folderWorkspaceId: folderId },
      { kind: 'folder', id: folderId, path: folder }
    )) as { status: string }

    expect(result.status).toBe('installed')
    expect(
      await readFile(join(folder, '.agents', 'skills', 'relay-skill', 'SKILL.md'), 'utf8')
    ).toContain('# Relay')
  })

  it('rejects a folder workspace whose host path is outside home', async () => {
    const { archive, bytes, call, root } = await fixture()
    const folder = join(root, 'outside-folder')
    await mkdir(folder)
    const folderId = '123e4567-e89b-12d3-a456-426614174000'

    await expect(
      installStagedSkill(
        call,
        archive,
        bytes,
        { scope: 'workspace', folderWorkspaceId: folderId },
        { kind: 'folder', id: folderId, path: folder }
      )
    ).rejects.toMatchObject({
      code: 'skill_install_failure',
      data: { category: 'admission', code: 'skill-install-destination-escape' }
    })
    await expect(
      readFile(join(folder, '.agents', 'skills', 'relay-skill', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
