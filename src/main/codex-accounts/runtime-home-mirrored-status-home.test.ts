import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../shared/managed-account-types'

const testState = { userData: '', home: '' }
const previousEnv: Record<string, string | undefined> = {}

vi.mock('electron', () => ({ app: { getPath: () => testState.userData } }))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userData }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.home }
})

beforeEach(() => {
  vi.resetModules()
  testState.userData = mkdtempSync(join(tmpdir(), 'orca-codex-status-home-ud-'))
  testState.home = mkdtempSync(join(tmpdir(), 'orca-codex-status-home-'))
  // Isolate routing checks from the developer's home overrides.
  for (const key of ['ORCA_USER_DATA_PATH', 'CODEX_HOME', 'ORCA_CODEX_HOME']) {
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

describe('CodexRuntimeHomeService.getMirroredHostHomePathForStatus', () => {
  it('returns null for the system default, which runs on the real home with no mirror', async () => {
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(createStore([], null) as never)

    expect(service.getMirroredHostHomePathForStatus()).toEqual({ kind: 'ready', homePath: null })
  })

  it('returns the selected account own home, which is what its mirror targets', async () => {
    const account = createManagedAccount('acct-1')
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(createStore([account], account.id) as never)

    expect(service.getMirroredHostHomePathForStatus()).toEqual({
      kind: 'ready',
      homePath: account.managedHomePath
    })
  })

  it('returns the shared runtime home when a custom CODEX_HOME keeps the mirror lane', async () => {
    process.env.CODEX_HOME = join(testState.home, 'custom-codex-home')
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { getOrcaManagedCodexHomePath } = await import('../codex/codex-home-paths')
    const service = new CodexRuntimeHomeService(createStore([], null) as never)

    expect(service.getMirroredHostHomePathForStatus()).toEqual({
      kind: 'ready',
      homePath: getOrcaManagedCodexHomePath()
    })
  })
})
