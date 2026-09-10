import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { createSkillPackageArchive } from '../main/skills/skill-package-creation'
import {
  SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD,
  SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD,
  SKILL_SSH_RELAY_INSTALL_METHOD,
  SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD
} from '../shared/skill-ssh-relay-contract'
import { runProcess } from '../shared/child-process/run-process'
import { SkillInstallHandler } from './skill-install-handler'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function gitInit(directory: string): Promise<boolean> {
  const result = await runProcess({
    program: 'git',
    args: ['-C', directory, 'init', '--quiet'],
    timeoutMs: 20_000
  }).catch(() => null)
  return result?.code === 0
}

/**
 * A relay handler plus a staged package, ready to install into whatever
 * `workspace` the caller claims. `checkout` is a real Git working tree on this
 * host; `plain` is an ordinary directory, standing in for `~/.ssh` or `/etc`.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-skill-authority-'))
  roots.push(root)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const source = join(root, 'source')
  const checkout = join(home, 'workspaces', 'feature')
  const plain = join(home, '.ssh')
  await Promise.all([
    mkdir(home),
    mkdir(source),
    mkdir(checkout, { recursive: true }),
    mkdir(plain, { recursive: true })
  ])
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
  const bytes = await readFile(archive.archivePath)
  const handlers = new Map<string, MethodHandler>()
  const dispatcher = {
    onRequest: vi.fn((method: string, handler: MethodHandler) => handlers.set(method, handler))
  } as unknown as RelayDispatcher
  new SkillInstallHandler(dispatcher, {
    homeDirectory: home,
    stateDirectory: state,
    detectProviders: async () => [],
    recovery: Promise.resolve()
  })
  const call = (method: string, params: Record<string, unknown>) =>
    handlers.get(method)!(params, {
      clientId: 1,
      isStale: () => false,
      signal: new AbortController().signal
    })

  const packageIdentity = {
    packageId: archive.manifest.packageId,
    versionId: archive.manifest.versionId,
    packageDigest: archive.manifest.packageDigest,
    archiveSha256: archive.archiveSha256,
    compressedBytes: bytes.length
  }

  async function install(workspacePath: string): Promise<{ status: string }> {
    const begun = (await call(SKILL_SSH_RELAY_BEGIN_UPLOAD_METHOD, {
      package: packageIdentity
    })) as { uploadId: string }
    await call(SKILL_SSH_RELAY_UPLOAD_CHUNK_METHOD, {
      uploadId: begun.uploadId,
      offset: 0,
      bytesBase64: bytes.toString('base64')
    })
    await call(SKILL_SSH_RELAY_COMMIT_UPLOAD_METHOD, { uploadId: begun.uploadId })
    return (await call(SKILL_SSH_RELAY_INSTALL_METHOD, {
      request: {
        operationId: `operation_${Math.random().toString(36).slice(2)}`,
        package: packageIdentity,
        ingress: { kind: 'staged-upload', uploadId: begun.uploadId },
        destination: { scope: 'workspace', worktreeId: 'worktree_1' }
      },
      workspace: { kind: 'worktree', id: 'worktree_1', path: workspacePath }
    })) as { status: string }
  }

  return { checkout, home, install, plain }
}

describe('SSH relay worktree install destinations', () => {
  it('refuses a client path that is not a checkout on this host', async () => {
    // #18273: `~/.ssh` matched the requested worktree id and was accepted as
    // the install root, because the relay handed the caller's path straight
    // back as authority.
    const { install, plain } = await fixture()

    await expect(install(plain)).rejects.toThrow(/skill-install-workspace-not-found/)
  })

  it('installs into a directory Git confirms is a checkout root', async () => {
    const { checkout, install } = await fixture()
    expect(await gitInit(checkout)).toBe(true)

    await expect(install(checkout)).resolves.toMatchObject({ status: 'installed' })
    await expect(
      readFile(join(checkout, '.agents', 'skills', 'relay-skill', 'SKILL.md'), 'utf8')
    ).resolves.toContain('# Relay')
  })

  it('refuses a path merely inside a checkout rather than its root', async () => {
    const { checkout, install } = await fixture()
    expect(await gitInit(checkout)).toBe(true)
    const nested = join(checkout, 'packages', 'app')
    await mkdir(nested, { recursive: true })

    await expect(install(nested)).rejects.toThrow(/skill-install-workspace-not-found/)
  })
})
