import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'

const testState = { userData: '', home: '' }
const previousEnv: Record<string, string | undefined> = {}

vi.mock('electron', () => ({ app: { getPath: () => testState.userData } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.home }
})

beforeEach(() => {
  vi.resetModules()
  testState.userData = mkdtempSync(join(tmpdir(), 'orca-codex-status-home-ud-'))
  testState.home = mkdtempSync(join(tmpdir(), 'orca-codex-status-home-'))
  // Why: the real-home check consults CODEX_HOME and the shell rc, so a
  // developer who exports one would otherwise fail this suite locally.
  for (const key of [
    'ORCA_USER_DATA_PATH',
    'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME',
    'CODEX_HOME',
    'ORCA_CODEX_HOME'
  ]) {
    previousEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.ORCA_USER_DATA_PATH = testState.userData
  mkdirSync(join(testState.home, '.codex'), { recursive: true })
})

afterEach(() => {
  rmSync(testState.userData, { recursive: true, force: true })
  rmSync(testState.home, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function createStore(accounts: CodexManagedAccount[], activeId: string | null) {
  const settings = {
    codexManagedAccounts: accounts,
    activeCodexManagedAccountId: activeId,
    activeCodexManagedAccountIdsByRuntime: { host: activeId, wsl: {} }
  } as GlobalSettings
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
  }
}

function createManagedAccount(id: string): CodexManagedAccount {
  const home = join(testState.userData, 'codex-accounts', id, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), `${id}\n`, 'utf-8')
  writeFileSync(join(home, 'auth.json'), '{}', 'utf-8')
  return {
    id,
    providerAccountId: id,
    email: `${id}@example.com`,
    managedHomePath: home,
    runtime: 'host'
  } as unknown as CodexManagedAccount
}

// Why: the config-sync status is only correct if it names the home the current
// selection actually mirrors into. Nothing else pins that resolution, so a
// change to the lane rules or the shared-home layout would silence the banner
// with every other test still green.
describe('CodexRuntimeHomeService.getMirroredHostHomePathForStatus', () => {
  it('returns null for the system default, which runs on the real home with no mirror', async () => {
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(createStore([], null) as never)

    expect(service.getMirroredHostHomePathForStatus()).toBeNull()
  })

  it('returns the selected account own home, which is what its mirror targets', async () => {
    const account = createManagedAccount('acct-1')
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(createStore([account], account.id) as never)

    expect(service.getMirroredHostHomePathForStatus()).toBe(account.managedHomePath)
  })

  it('returns the shared runtime home when the real-home lane is off', async () => {
    process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME = '0'
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { getOrcaManagedCodexHomePath } = await import('../codex/codex-home-paths')
    const service = new CodexRuntimeHomeService(createStore([], null) as never)

    // Why: compare against the real helper, not a repeated literal, so the
    // status cannot silently drift if the managed home layout ever moves.
    expect(service.getMirroredHostHomePathForStatus()).toBe(getOrcaManagedCodexHomePath())
  })
})
