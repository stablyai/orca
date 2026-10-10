import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'

const removedSettings = {
  codexManagedAccounts: [],
  activeCodexManagedAccountId: null,
  activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} }
}

async function seededAccount() {
  const state = await fixture()
  state.store.updateSettings({
    codexManagedAccounts: [
      {
        id: 'account-host',
        email: 'user@example.com',
        managedHomePath: join(tmpdir(), 'orca-account-host', 'home'),
        managedHomeRuntime: 'host',
        wslDistro: null,
        createdAt: 1,
        updatedAt: 42,
        lastAuthenticatedAt: 1
      }
    ],
    activeCodexManagedAccountId: 'account-host',
    activeCodexManagedAccountIdsByRuntime: { host: 'account-host', wsl: {} }
  })
  await state.store.replaceCodexResetCreditAttemptLedgerAndFlush({
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
  })
  state.authority.captures.length = 0
  return state
}

describe('asynchronous Codex account removal', () => {
  it('retains durable recovery metadata when the removal commits but loses its acknowledgement', async () => {
    const { store, authority, readState } = await seededAccount()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const account = store.getSettings().codexManagedAccounts[0]
    const gate = authority.pause()
    const rejected = expect(
      store.updateCodexAccountStateAndFlush(
        {
          ...removedSettings,
          codexAccountRemovalRecovery: store.getSettings().codexManagedAccounts
        },
        {
          version: 1,
          attempts: []
        }
      )
    ).rejects.toMatchObject({ outcome: 'indeterminate' })
    await gate.started.promise
    const captured = authority.captures.at(-1)
    if (!captured) {
      throw new Error('Expected captured removal domains')
    }
    authority.inner.writeSerializedDomains(captured)
    gate.finish.reject(
      new ProfileStateWriterError('test-worker-exit', 'acknowledgement lost', 'indeterminate')
    )
    await rejected
    expect(readState()).toMatchObject({
      settings: { codexManagedAccounts: [], codexAccountRemovalRecovery: [account] },
      codexResetCreditAttemptLedger: { attempts: [] }
    })
  })

  it('keeps the account and reset guards when recovery metadata cannot reach storage', async () => {
    const { store, authority, readState } = await seededAccount()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const account = store.getSettings().codexManagedAccounts[0]
    authority.failNextWrite()
    await expect(
      store.updateCodexAccountStateAndFlush(
        { ...removedSettings, codexAccountRemovalRecovery: [account] },
        { version: 1, attempts: [] }
      )
    ).rejects.toThrow('profile_state_write_failed')
    expect(store.getSettings().codexManagedAccounts).toEqual([account])
    expect(readState().settings.codexManagedAccounts).toEqual([account])
    expect(readState().codexResetCreditAttemptLedger.attempts).toHaveLength(1)
  })

  it('acknowledges and publishes only after account settings and reset guards commit together', async () => {
    const { store, authority, readState } = await seededAccount()
    const changed = vi.fn()
    store.onSettingsChanged(changed)
    const gate = authority.pause()
    let acknowledged = false
    const pending = store
      .updateCodexAccountStateAndFlush(removedSettings, {
        version: 1,
        attempts: []
      })
      .then(() => {
        acknowledged = true
      })
    await gate.started.promise
    expect(acknowledged).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(readState().settings.codexManagedAccounts).toHaveLength(1)
    expect(readState().codexResetCreditAttemptLedger.attempts).toHaveLength(1)
    gate.finish.resolve()
    await pending
    expect(acknowledged).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    expect(readState()).toMatchObject({
      settings: removedSettings,
      codexResetCreditAttemptLedger: { attempts: [] }
    })
    expect(authority.captures).toHaveLength(1)
  })

  it('restores both account fields and reset guards after a known failure, preserving later preferences', async () => {
    const { store, authority, readState } = await seededAccount()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = structuredClone(store.getSettings())
    const ledger = store.getCodexResetCreditAttemptLedger()
    const changed = vi.fn()
    store.onSettingsChanged(changed)
    const gate = authority.pause()
    const rejected = expect(
      store.updateCodexAccountStateAndFlush(
        {
          ...removedSettings,
          codexAccountRemovalRecovery: store.getSettings().codexManagedAccounts
        },
        {
          version: 1,
          attempts: []
        }
      )
    ).rejects.toThrow('disk refused')
    await gate.started.promise
    store.updateSettings({ theme: 'dark' })
    gate.finish.reject(
      new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
    )
    await rejected
    expect(store.getSettings()).toMatchObject({
      codexManagedAccounts: before.codexManagedAccounts,
      activeCodexManagedAccountId: before.activeCodexManagedAccountId,
      activeCodexManagedAccountIdsByRuntime: before.activeCodexManagedAccountIdsByRuntime,
      theme: 'dark'
    })
    expect(store.getCodexResetCreditAttemptLedger()).toEqual(ledger)
    expect(changed).not.toHaveBeenCalled()
    expect(readState().settings.codexManagedAccounts).toEqual(before.codexManagedAccounts)
  })

  it('does not assume an indeterminate write can be rolled back', async () => {
    const { store, authority } = await seededAccount()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const changed = vi.fn()
    store.onSettingsChanged(changed)
    const gate = authority.pause()
    const rejected = expect(
      store.updateCodexAccountStateAndFlush(
        {
          ...removedSettings,
          codexAccountRemovalRecovery: store.getSettings().codexManagedAccounts
        },
        {
          version: 1,
          attempts: []
        }
      )
    ).rejects.toMatchObject({ outcome: 'indeterminate' })
    await gate.started.promise
    gate.finish.reject(
      new ProfileStateWriterError('test-worker-exit', 'worker exited', 'indeterminate')
    )
    await rejected
    expect(store.getSettings().codexManagedAccounts).toEqual([])
    expect(store.getCodexResetCreditAttemptLedger().attempts).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })
})
