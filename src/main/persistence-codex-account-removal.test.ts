import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { CodexResetCreditAttemptLedger } from '../shared/codex-reset-credit-attempt-ledger'
import { getDefaultPersistedState } from '../shared/constants'
import {
  testState,
  createStore,
  closeTestStores,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
import { ProfileStateSqliteAuthority } from './persistence/profile-state/profile-state-sqlite-authority'

function createPersistedCodexAccount(): GlobalSettings['codexManagedAccounts'][number] {
  return {
    id: 'account-host',
    email: 'user@example.com',
    managedHomePath: join(testState.dir, 'account-host', 'home'),
    managedHomeRuntime: 'host',
    wslDistro: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function createPendingCodexResetLedger(): CodexResetCreditAttemptLedger {
  return {
    version: 1,
    attempts: [
      {
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        expectedScope: {
          target: { runtime: 'host', wslDistro: null },
          accountId: 'account-host',
          accountRevision: 42,
          offerRevision: 'v1:offer'
        },
        state: 'providerPending'
      }
    ]
  }
}

describe('Codex account removal persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-account-removal-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists Codex account removal and reset-ledger cleanup in one flush', async () => {
    const store = createStore()
    const account = createPersistedCodexAccount()
    store.updateSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: 'account-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-host', wsl: {} }
    })
    await store.replaceCodexResetCreditAttemptLedgerAndFlush(createPendingCodexResetLedger())

    await store.updateCodexAccountSettingsAndResetLedgerAndFlush(
      {
        codexManagedAccounts: [],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
      },
      { version: 1, attempts: [] }
    )

    expect(store.getSettings().codexManagedAccounts).toEqual([])
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
    expect(readDataFile()).toMatchObject({
      settings: { codexManagedAccounts: [] },
      codexResetCreditAttemptLedger: { attempts: [] }
    })
  })

  it('reloads removal recovery metadata after the normal account record has committed away', async () => {
    const store = createStore()
    const account = createPersistedCodexAccount()
    store.updateSettings({ codexManagedAccounts: [account] })
    await store.retainCodexAccountRemovalRecoveryAndFlush(account)
    expect(readDataFile()).toMatchObject({
      settings: { codexManagedAccounts: [account], codexAccountRemovalRecovery: [account] }
    })
    await store.updateCodexAccountSettingsAndResetLedgerAndFlush(
      {
        codexManagedAccounts: [],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
      },
      { version: 1, attempts: [] }
    )
    const reloaded = createStore()
    expect(reloaded.getSettings()).toMatchObject({
      codexManagedAccounts: [],
      codexAccountRemovalRecovery: [account]
    })
  })

  it('restores Codex account settings when pre-removal reconciliation fails', async () => {
    const store = createStore()
    const account = createPersistedCodexAccount()
    store.updateSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: 'account-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-host', wsl: {} }
    })
    store.flushOrThrow()
    const beforeSettings = structuredClone(store.getSettings())

    expect(() =>
      store.withCodexAccountSettingsPreview(
        {
          codexManagedAccounts: [],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        () => {
          expect(store.getSettings().codexManagedAccounts).toEqual([])
          throw new Error('activation failed')
        }
      )
    ).toThrow('activation failed')

    expect(store.getSettings()).toEqual(beforeSettings)
    expect(readDataFile()).toEqual(expect.objectContaining({ settings: beforeSettings }))
  })

  it('rejects asynchronous Codex account settings preview callbacks', async () => {
    const store = createStore()
    const beforeSettings = structuredClone(store.getSettings())

    expect(() =>
      store.withCodexAccountSettingsPreview(
        {
          codexManagedAccounts: [],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        () => Promise.reject(new Error('async failed'))
      )
    ).toThrow('Codex account settings preview callback must be synchronous')

    await Promise.resolve()
    expect(store.getSettings()).toEqual(beforeSettings)
  })

  it('rejects nested Codex account settings previews', async () => {
    const store = createStore()
    const beforeSettings = structuredClone(store.getSettings())
    const preview = {
      codexManagedAccounts: [],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
    }

    expect(() =>
      store.withCodexAccountSettingsPreview(preview, () => {
        store.withCodexAccountSettingsPreview(preview, () => {})
      })
    ).toThrow('Cannot nest Codex account settings previews')

    expect(store.getSettings()).toEqual(beforeSettings)
  })

  it('folds selection self-healing into the preview without publishing or saving it', async () => {
    const store = createStore()
    const account = createPersistedCodexAccount()
    store.updateSettings({ codexManagedAccounts: [account] })
    await store.updateCodexAccountSettingsAndFlush({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id,
      activeCodexManagedAccountIdsByRuntime: { host: account.id, wsl: {} }
    })
    const beforeSettings = structuredClone(store.getSettings())
    const changed = vi.fn()
    store.onSettingsChanged(changed)
    const repaired = store.withCodexAccountSettingsPreview(beforeSettings, () => {
      store.updateSettings(
        {
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        { notifyListeners: true }
      )
      return structuredClone(store.getSettings())
    })
    expect(repaired.activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings()).toEqual(beforeSettings)
    expect(changed).not.toHaveBeenCalled()
    expect(readDataFile()).toEqual(expect.objectContaining({ settings: beforeSettings }))
    await store.updateCodexAccountSettingsAndResetLedgerAndFlush(repaired, {
      version: 1,
      attempts: []
    })
    expect(createStore().getSettings().activeCodexManagedAccountId).toBeNull()
  })

  it.each([
    { uiLanguage: 'ja' as const },
    { codexManagedAccounts: [] },
    { activeCodexManagedAccountId: null, uiLanguage: 'ja' as const }
  ])('rejects non-selection preview updates atomically: %j', async (updates) => {
    const store = createStore()
    const beforeSettings = structuredClone(store.getSettings())

    expect(() =>
      store.withCodexAccountSettingsPreview(
        {
          codexManagedAccounts: [],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        () => {
          store.updateSettings(updates)
        }
      )
    ).toThrow('Cannot update settings during a Codex account settings preview')

    expect(store.getSettings()).toEqual(beforeSettings)
  })

  it('rejects persistence during a Codex account settings preview', async () => {
    const store = createStore()
    store.flushOrThrow()
    const beforeSettings = structuredClone(store.getSettings())

    expect(() =>
      store.withCodexAccountSettingsPreview(
        {
          codexManagedAccounts: [],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        () => {
          store.flushOrThrow()
        }
      )
    ).toThrow('Cannot persist during a Codex account settings preview')

    expect(store.getSettings()).toEqual(beforeSettings)
    expect(readDataFile()).toEqual(expect.objectContaining({ settings: beforeSettings }))
  })

  it('rolls Codex account settings and reset ledger back together when removal flush fails', async () => {
    const store = createStore()
    const account = createPersistedCodexAccount()
    const ledger = createPendingCodexResetLedger()
    store.updateSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: 'account-host',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-host', wsl: {} }
    })
    await store.replaceCodexResetCreditAttemptLedgerAndFlush(ledger)
    const beforeSettings = structuredClone(store.getSettings())
    vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeCompleteSerializedDomains'
    ).mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(
      store.updateCodexAccountSettingsAndResetLedgerAndFlush(
        {
          codexManagedAccounts: [],
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
        },
        { version: 1, attempts: [] }
      )
    ).rejects.toThrow('disk full')

    expect(store.getSettings()).toEqual(beforeSettings)
    expect(store.getCodexResetCreditAttemptLedger()).toEqual(ledger)
    expect(readDataFile()).toEqual(
      expect.objectContaining({ settings: beforeSettings, codexResetCreditAttemptLedger: ledger })
    )
  })

  it('preserves a corrupt Codex reset ledger as a fail-closed read error', async () => {
    const account = createPersistedCodexAccount()
    const corruptLedger = {
      version: 1,
      attempts: [{ state: 'providerPending' }]
    }
    const initialState = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...initialState,
      settings: {
        ...initialState.settings,
        codexManagedAccounts: [account],
        activeCodexManagedAccountId: 'account-host',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-host', wsl: {} }
      },
      codexResetCreditAttemptLedger: corruptLedger
    })

    const store = createStore()
    expect(() => store.getCodexResetCreditAttemptLedger()).toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
    await store.updateCodexAccountSettingsAndFlush({
      codexManagedAccounts: [],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
    })

    expect(store.getSettings().codexManagedAccounts).toEqual([])
    expect(() => store.getCodexResetCreditAttemptLedger()).toThrow(
      'Codex reset-credit attempt ledger is corrupt'
    )
    expect(readDataFile()).toMatchObject({
      settings: { codexManagedAccounts: [] },
      codexResetCreditAttemptLedger: corruptLedger
    })
  })
})
