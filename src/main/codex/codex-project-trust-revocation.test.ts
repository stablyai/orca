import type * as NodeOs from 'node:os'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

const { markCodexProjectTrusted } = await import('../agent-trust-presets')
const { readCodexProjectTrustLedger, recordCodexProjectTrustCreated } =
  await import('./codex-project-trust-ledger')
const { revokeCodexProjectTrustForRemovedWorkspace } =
  await import('./codex-project-trust-revocation')

let rootDir: string
let previousUserDataPath: string | undefined
let runtimeConfig: string
let systemConfig: string
let accountConfig: string
let workspacesDir: string

const EMPTY_LEDGER = { configs: {}, pendingMirrorCleanup: [] }
const trustTable = (path: string): string => `[projects."${path}"]\ntrust_level = "trusted"\n`
const read = (file: string): string => readFileSync(file, 'utf-8')

async function preTrust(path: string): Promise<void> {
  await markCodexProjectTrusted(path, [runtimeConfig, systemConfig], (configFile, projectPath) =>
    recordCodexProjectTrustCreated(configFile, projectPath)
  )
  // Stands in for the config mirror, which copies ~/.codex tables into each account home.
  writeFileSync(accountConfig, `${read(accountConfig)}\n${trustTable(realpathSync(path))}`)
}

beforeEach(() => {
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-trust-revocation-')))
  const userData = join(rootDir, 'user-data')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userData
  homedirMock.mockReturnValue(join(rootDir, 'home'))
  runtimeConfig = join(userData, 'codex-runtime-home', 'home', 'config.toml')
  systemConfig = join(rootDir, 'home', '.codex', 'config.toml')
  accountConfig = join(userData, 'codex-accounts', 'acct-1', 'home', 'config.toml')
  workspacesDir = join(rootDir, 'workspaces')
  for (const file of [runtimeConfig, systemConfig, accountConfig]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'model = "gpt-5"\n')
  }
  writeFileSync(join(accountConfig, '..', '.orca-managed-home'), 'acct-1\n')
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(rootDir, { recursive: true, force: true })
})

describe('revokeCodexProjectTrustForRemovedWorkspace', () => {
  it('removes the trust Orca wrote for a removed worktree from every home', async () => {
    const worktree = join(workspacesDir, 'repo-r1')
    mkdirSync(join(worktree, 'pkg'), { recursive: true })
    await preTrust(worktree)
    await preTrust(join(worktree, 'pkg'))
    rmSync(worktree, { recursive: true })

    await revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: worktree, remainingRoots: [] })

    for (const file of [runtimeConfig, systemConfig, accountConfig]) {
      expect(read(file)).toBe('model = "gpt-5"\n')
    }
    expect(readCodexProjectTrustLedger()).toEqual(EMPTY_LEDGER)
  })

  it('leaves a table that existed before Orca pre-trusted the path', async () => {
    const worktree = join(workspacesDir, 'repo-r2')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(systemConfig, `model = "gpt-5"\n\n${trustTable(worktree)}`)
    await preTrust(worktree)

    await revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: worktree, remainingRoots: [] })

    expect(read(runtimeConfig)).toBe('model = "gpt-5"\n')
    expect(read(systemConfig)).toContain(trustTable(worktree))
    // Why: the user's own ~/.codex table still feeds the mirror, so its account copy stays.
    expect(read(accountConfig)).toContain(trustTable(worktree))
  })

  it('leaves a table the user edited after Orca wrote it', async () => {
    const worktree = join(workspacesDir, 'repo-r3')
    mkdirSync(worktree, { recursive: true })
    await preTrust(worktree)
    writeFileSync(systemConfig, read(systemConfig).replace('"trusted"', '"untrusted"'))

    await revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: worktree, remainingRoots: [] })

    expect(read(systemConfig)).toContain('trust_level = "untrusted"')
    expect(read(runtimeConfig)).toBe('model = "gpt-5"\n')
    // Why: `untrusted` is a revocation, the same reading the config mirror gives it.
    expect(read(accountConfig)).toBe('model = "gpt-5"\n')
    expect(readCodexProjectTrustLedger()).toEqual(EMPTY_LEDGER)
  })

  it('keeps account copies when a source cannot be read, rather than assuming it is empty', async () => {
    const worktree = join(workspacesDir, 'repo-r4')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(systemConfig, `model = "gpt-5"\n\n${trustTable(worktree)}`)
    await preTrust(worktree)
    chmodSync(systemConfig, 0o000)

    await expect(
      revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: worktree, remainingRoots: [] })
    ).rejects.toThrow()

    chmodSync(systemConfig, 0o600)
    expect(read(accountConfig)).toContain(trustTable(worktree))
  })

  it('retries account copies it could not reach on the next revocation', async () => {
    const first = join(workspacesDir, 'repo-r5')
    const second = join(workspacesDir, 'repo-r6')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    await preTrust(first)
    await preTrust(second)
    const accountsRoot = join(accountConfig, '..', '..', '..')
    chmodSync(accountsRoot, 0o000)

    await expect(
      revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: first, remainingRoots: [] })
    ).rejects.toThrow()

    chmodSync(accountsRoot, 0o700)
    expect(read(systemConfig)).not.toContain(trustTable(first))
    expect(readCodexProjectTrustLedger().pendingMirrorCleanup).toEqual([first])

    await revokeCodexProjectTrustForRemovedWorkspace({ removedRoot: second, remainingRoots: [] })

    expect(read(accountConfig)).toBe('model = "gpt-5"\n')
    expect(readCodexProjectTrustLedger()).toEqual(EMPTY_LEDGER)
  })

  it('keeps writing trust to every file when the ledger cannot be recorded', async () => {
    const worktree = join(workspacesDir, 'repo-r7')
    mkdirSync(worktree, { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await markCodexProjectTrusted(worktree, [runtimeConfig, systemConfig], () => {
      throw new Error('EROFS')
    })

    expect(read(runtimeConfig)).toContain(trustTable(worktree))
    expect(read(systemConfig)).toContain(trustTable(worktree))
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps trust for another workspace session on the same folder', async () => {
    const folder = join(workspacesDir, 'shared-folder')
    mkdirSync(folder, { recursive: true })
    await preTrust(folder)

    await revokeCodexProjectTrustForRemovedWorkspace({
      removedRoot: folder,
      remainingRoots: [folder]
    })

    expect(read(systemConfig)).toContain(trustTable(folder))
    expect(read(accountConfig)).toContain(trustTable(folder))
  })

  it('removes a nested worktree even though its enclosing repo remains', async () => {
    const repo = join(workspacesDir, 'repo')
    const worktree = join(repo, '.worktrees', 'feature')
    mkdirSync(worktree, { recursive: true })
    await preTrust(repo)
    await preTrust(worktree)

    await revokeCodexProjectTrustForRemovedWorkspace({
      removedRoot: worktree,
      remainingRoots: [repo]
    })

    expect(read(systemConfig)).toBe(`model = "gpt-5"\n\n${trustTable(repo)}`)
    expect(read(accountConfig)).not.toContain(trustTable(worktree))
    expect(read(accountConfig)).toContain(trustTable(repo))
  })
})
