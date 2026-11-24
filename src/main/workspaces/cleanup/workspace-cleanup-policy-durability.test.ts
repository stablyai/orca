import { expect, it, vi } from 'vitest'
import { fixture } from '../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import {
  captureWorkspaceCleanupPolicyAuthority,
  persistGuardedSettingsPolicy,
  readDurableWorkspaceCleanupPolicy
} from './workspace-cleanup-policy-durability'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))

async function savedRules() {
  const profile = await fixture()
  const before = getDefaultWorkspaceCleanupRules()
  profile.store.updateSettings({ workspaceCleanupPolicy: before })
  await profile.store.flushPendingOrThrowAsync()
  const saved = () => profile.readState().settings?.workspaceCleanupPolicy
  return { ...profile, before, saved }
}

it('puts the previous rules back when the save fails, before cleanup reads them', async () => {
  const { store, authority, before, saved } = await savedRules()
  const enabled = { ...before, merged: { enabled: true } }
  const gate = authority.pause()
  authority.failNextWrite()
  store.updateSettings({ workspaceCleanupPolicy: enabled })
  const save = persistGuardedSettingsPolicy(
    store,
    { workspaceCleanupGuard: {} },
    { workspaceCleanupPolicy: before }
  )
  await gate.started.promise
  let cleanupMayRead = false
  const cleanup = captureWorkspaceCleanupPolicyAuthority().then((authority) => {
    cleanupMayRead = true
    return authority
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  // The rule is in memory but not saved: a cleanup decision waits.
  expect(cleanupMayRead).toBe(false)
  gate.finish.resolve()
  await expect(save).rejects.toThrow('profile_state_write_failed')
  // The rollback is itself a rules write, so a decision taken before it can't be admitted after it.
  expect((await cleanup).stillCurrent()).toBe(true)
  expect(store.getSettings().workspaceCleanupPolicy).toEqual(before)
  expect(saved()?.merged).toEqual({ enabled: false })
})

it('answers a readback only with rules already saved, not a newer write still saving', async () => {
  const { store, authority, before, saved } = await savedRules()
  const first = { ...before, merged: { enabled: true } }
  const second = { ...first, inactive: { ...first.inactive, enabled: true } }
  store.updateSettings({ workspaceCleanupPolicy: first })
  const gate = authority.pause()
  const read = readDurableWorkspaceCleanupPolicy(store, () => ({
    state: store.getSettings().workspaceCleanupPolicy
  }))
  await gate.started.promise
  // Another client's write lands in memory while the first one is still being saved.
  store.updateSettings({ workspaceCleanupPolicy: second })
  gate.finish.resolve()
  const answer = await read
  expect(answer.state).toEqual(saved())
  expect(answer.state).toEqual(second)
})

it('does not mistake rules written away and back for one saved generation', async () => {
  const { store, authority, before, saved } = await savedRules()
  const protective = { ...before, keepWhen: 'any-local-files' as const }
  const destructive = { ...before, merged: { enabled: true } }
  store.updateSettings({ workspaceCleanupPolicy: protective })
  await store.flushPendingOrThrowAsync()
  // Something unsaved, so the readback's own save writes the profile.
  store.updateSettings({ terminalLinkClickBehavior: 'open' })
  const captured = authority.pause()
  const read = readDurableWorkspaceCleanupPolicy(store, () => ({
    state: store.getSettings().workspaceCleanupPolicy
  }))
  // Written after the read, before its save captures the profile: that save holds the destructive rules.
  store.updateSettings({ workspaceCleanupPolicy: destructive })
  await captured.started.promise
  // Put the protective rules back while that save is held.
  store.updateSettings({ workspaceCleanupPolicy: protective })
  captured.finish.resolve()
  const answer = await read
  expect(answer.state).toEqual(saved())
})

it('lets a decision be admitted only while no rules were written or are being saved since', async () => {
  const { store, before } = await savedRules()
  const decision = await captureWorkspaceCleanupPolicyAuthority()
  expect(decision.stillCurrent()).toBe(true)
  store.updateSettings({ workspaceCleanupPolicy: before })
  // The same value written again still counts.
  expect(decision.stillCurrent()).toBe(false)
})
