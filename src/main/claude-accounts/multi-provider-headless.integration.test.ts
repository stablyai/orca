// Why: end-to-end coverage for the headless CLI surface — exercises the real
// service stack (Store + ClaudeAccountService) reachable from
// `orca claude-accounts add|list|select`, with a fake SecretsStorage backend
// injected so secrets round-trip through the abstraction without hitting the
// macOS Keychain or sodium-native. Mirrors what the CLI handler does when no
// running Orca app is reachable. (P4 Task 19)
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testState = { userDataDir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

// Why: the real Store debounces disk writes by 300ms, so successive
// loadClaudeAccountServiceHeadless() calls in one test would read stale state.
// Hoist a single Store instance into the persistence import so add → list → select
// share in-memory state the same way they would inside a long-running CLI
// process. Real Store + real ClaudeAccountService — only the persistence boundary
// is short-circuited.
const persistenceMock = vi.hoisted(() => {
  let sharedStore: unknown = null
  return {
    initDataPath: vi.fn(() => {}),
    getSharedStore: () => sharedStore,
    setSharedStore: (s: unknown) => {
      sharedStore = s
    }
  }
})
vi.mock('../persistence', async () => {
  const actual = await vi.importActual<typeof import('../persistence')>('../persistence') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    initDataPath: persistenceMock.initDataPath,
    Store: class WrappedStore {
      constructor() {
        const existing = persistenceMock.getSharedStore()
        if (existing) {
          return existing as never
        }
        const real = new actual.Store()
        persistenceMock.setSharedStore(real)
        return real as never
      }
    }
  }
})

// Why: anthropic-api-key + anthropic-compat handlers don't shell out to provider
// APIs during register(); they just persist the secret through the SecretsStorage
// abstraction. We don't mock the handlers — the fake backend below is the
// boundary that matters for this test.

import {
  runHeadlessClaudeAccountsAdd,
  runHeadlessClaudeAccountsList,
  runHeadlessClaudeAccountsSelect
} from './headless-bootstrap'
import { setSecretsBackendForTest } from './secrets-storage'

const fakeBackend = (() => {
  const records = new Map<string, string>()
  return {
    backendId: 'encrypted-file' as const,
    read: vi.fn(async (s: string, a: string) => records.get(`${s}::${a}`) ?? null),
    write: vi.fn(async (s: string, a: string, v: string) => {
      records.set(`${s}::${a}`, v)
    }),
    delete: vi.fn(async (s: string, a: string) => {
      records.delete(`${s}::${a}`)
    }),
    __records: records
  }
})()

beforeEach(() => {
  // Fresh tmp dir per test so disk state never accumulates across cases.
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-headless-int-'))
  mkdirSync(testState.userDataDir, { recursive: true })
  // Drop the shared Store so each test gets a clean settings slate while still
  // sharing one Store across the calls inside that test.
  persistenceMock.setSharedStore(null)
  fakeBackend.__records.clear()
  fakeBackend.read.mockClear()
  fakeBackend.write.mockClear()
  fakeBackend.delete.mockClear()
  setSecretsBackendForTest(fakeBackend)
})

afterEach(() => {
  setSecretsBackendForTest(null)
  if (testState.userDataDir) {
    rmSync(testState.userDataDir, { recursive: true, force: true })
  }
})

describe('headless multi-provider integration', () => {
  it('add anthropic-api-key → list reflects it → select activates it', async () => {
    const add = await runHeadlessClaudeAccountsAdd({
      authMethod: 'anthropic-api-key',
      label: 'CLI Work',
      secretFromUser: 'sk-ant-cli'
    })
    expect(add.accountId).toBeDefined()
    expect(add.accountId).toMatch(/.+/)

    const list = await runHeadlessClaudeAccountsList()
    expect(list.accounts).toHaveLength(1)

    const sel = await runHeadlessClaudeAccountsSelect(add.accountId)
    expect(sel.activeAccountId).toBe(add.accountId)
  })

  it('add anthropic-compat zai → secret round-trips through fake backend', async () => {
    const add = await runHeadlessClaudeAccountsAdd({
      authMethod: 'anthropic-compat',
      label: 'CLI GLM',
      secretFromUser: 'zai-tok',
      providerConfig: { preset: 'zai' } as never
    })
    expect(fakeBackend.write).toHaveBeenCalledWith(
      'Orca Claude Code Managed Credentials',
      add.accountId,
      'zai-tok'
    )
  })
})
