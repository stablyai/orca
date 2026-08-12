import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertOwnedHostCodexManagedHomePath } from './host-codex-managed-home-ownership'

describe('assertOwnedHostCodexManagedHomePath', () => {
  let rootDir: string
  let userDataDir: string
  let systemHomePath: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'orca-managed-home-ownership-'))
    userDataDir = join(rootDir, 'user-data')
    systemHomePath = join(rootDir, 'home', '.codex')
    mkdirSync(join(userDataDir, 'codex-accounts'), { recursive: true })
    mkdirSync(systemHomePath, { recursive: true })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('accepts the expected marked account home', () => {
    const accountHome = join(userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(accountHome, { recursive: true })
    writeFileSync(join(accountHome, '.orca-managed-home'), 'account-1\n', 'utf-8')

    expect(
      assertOwnedHostCodexManagedHomePath({
        candidatePath: accountHome,
        managedAccountsRoot: join(userDataDir, 'codex-accounts'),
        systemCodexHomePath: systemHomePath,
        expectedAccountId: 'account-1'
      })
    ).toBe(realpathSync(accountHome))
  })

  it('rejects an account path redirected into the sandboxed system Codex home', () => {
    const systemAccountHome = join(systemHomePath, 'account-1', 'home')
    mkdirSync(systemAccountHome, { recursive: true })
    writeFileSync(join(systemAccountHome, '.orca-managed-home'), 'account-1\n', 'utf-8')
    const sentinelPath = join(systemHomePath, 'auth.json')
    writeFileSync(sentinelPath, 'system-auth\n', 'utf-8')

    rmSync(join(userDataDir, 'codex-accounts'), { recursive: true, force: true })
    symlinkSync(
      systemHomePath,
      join(userDataDir, 'codex-accounts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    expect(() =>
      assertOwnedHostCodexManagedHomePath({
        candidatePath: join(userDataDir, 'codex-accounts', 'account-1', 'home'),
        managedAccountsRoot: join(userDataDir, 'codex-accounts'),
        systemCodexHomePath: systemHomePath,
        expectedAccountId: 'account-1'
      })
    ).toThrow('resolves inside the system Codex home')
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('system-auth\n')
  })

  it('rejects a persisted home or marker belonging to another account', () => {
    const accountHome = join(userDataDir, 'codex-accounts', 'account-2', 'home')
    mkdirSync(accountHome, { recursive: true })
    writeFileSync(join(accountHome, '.orca-managed-home'), 'account-2\n', 'utf-8')

    expect(() =>
      assertOwnedHostCodexManagedHomePath({
        candidatePath: accountHome,
        managedAccountsRoot: join(userDataDir, 'codex-accounts'),
        systemCodexHomePath: systemHomePath,
        expectedAccountId: 'account-1'
      })
    ).toThrow('does not match its persisted account ID')
  })
})
