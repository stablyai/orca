import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { SettingsUpdate } from '../../shared/rpc-contract/client-settings-params'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

function hostController(store: Awaited<ReturnType<typeof fixture>>['store']) {
  return new RuntimeClientSettingsController(store, undefined, () => true)
}

describe('host usage request settings', () => {
  it('reads Antigravity from UI and durably applies both policy routes without persisting aliases', async () => {
    const { store, readState } = await fixture()
    const controller = hostController(store)
    const items = store.getUI().statusBarItems.filter((item) => item !== 'antigravity')
    store.updateUI({ statusBarItems: items })
    expect(controller.get()).toMatchObject({
      usageRequestPolicyVersion: 1,
      antigravityUsageEnabled: false
    })
    const first = await controller.update(
      SettingsUpdate.parse({
        usageRequestEnabled: { claude: false },
        antigravityUsageEnabled: true
      })
    )
    expect(first).toMatchObject({
      usageRequestEnabled: { claude: false },
      antigravityUsageEnabled: true
    })
    expect(store.getUI().statusBarItems).toEqual([...items, 'antigravity'])
    await controller.update({
      usageRequestEnabled: { codex: false },
      antigravityUsageEnabled: false
    })
    expect(readState().settings.usageRequestEnabled).toEqual({ claude: false, codex: false })
    expect(readState().ui.statusBarItems).toEqual(items)
    expect(readState().settings).not.toHaveProperty('antigravityUsageEnabled')
    expect(readState().settings).not.toHaveProperty('usageRequestPolicyVersion')
    const poisonedUpdates = Object.assign(
      {},
      {
        usageRequestEnabled: { claude: false },
        antigravityUsageEnabled: false,
        usageRequestPolicyVersion: 1
      }
    )
    store.updateSettings(poisonedUpdates)
    expect(store.getSettings()).not.toHaveProperty('antigravityUsageEnabled')
    expect(store.getSettings()).not.toHaveProperty('usageRequestPolicyVersion')
  })

  it('withholds acknowledgement until the database commits', async () => {
    const { store, authority, readState } = await fixture()
    const controller = hostController(store)
    const gate = authority.pause()
    let acknowledged = false
    const writing = controller.update({ usageRequestEnabled: { claude: false } }).then((result) => {
      acknowledged = true
      return result
    })
    try {
      await Promise.race([gate.started.promise, writing])
      expect(acknowledged).toBe(false)
      expect(readState().settings.usageRequestEnabled?.claude).not.toBe(false)
    } finally {
      gate.finish.resolve()
    }
    expect((await writing).usageRequestEnabled?.claude).toBe(false)
    expect(readState().settings.usageRequestEnabled.claude).toBe(false)
  })

  it('rejects a failed write and restores the previous effective host policy', async () => {
    const { store, authority, readState } = await fixture()
    const controller = hostController(store)
    await controller.update({
      usageRequestEnabled: { codex: false },
      antigravityUsageEnabled: true
    })
    authority.failNextWrite()
    try {
      await expect(
        controller.update({
          usageRequestEnabled: { claude: false },
          antigravityUsageEnabled: false
        })
      ).rejects.toThrow('profile_state_write_failed')
    } finally {
      await store.flushPendingOrThrowAsync().catch(() => {})
    }
    expect(controller.get()).toMatchObject({
      usageRequestEnabled: { codex: false },
      antigravityUsageEnabled: true
    })
    expect(controller.get().usageRequestEnabled?.claude).not.toBe(false)
    expect(readState().settings.usageRequestEnabled.codex).toBe(false)
    await controller.update({ usageRequestEnabled: { claude: false } })
    expect(readState().settings.usageRequestEnabled).toMatchObject({ claude: false, codex: false })
  })

  it('merges queued provider choices against the latest committed policy', async () => {
    const { store, authority, readState } = await fixture()
    const controller = hostController(store)
    const gate = authority.pause()
    const first = controller.update({ usageRequestEnabled: { claude: false } })
    const second = controller.update({ usageRequestEnabled: { codex: false } })
    try {
      await gate.started.promise
    } finally {
      gate.finish.resolve()
    }
    await Promise.all([first, second])
    expect(readState().settings.usageRequestEnabled).toEqual({ claude: false, codex: false })
  })

  it('does not advertise or acknowledge policy on a desktop-owned WSL guest', async () => {
    const { store } = await fixture()
    const controller = new RuntimeClientSettingsController(store, undefined, () => false)
    const update = vi.spyOn(store, 'updateSettings')
    const updateUI = vi.spyOn(store, 'updateUI')
    expect(controller.get()).not.toHaveProperty('usageRequestPolicyVersion')
    expect(controller.get()).not.toHaveProperty('usageRequestEnabled')
    await expect(controller.update({ usageRequestEnabled: { claude: false } })).rejects.toThrow(
      'usage_policy_unavailable'
    )
    await expect(controller.update({ antigravityUsageEnabled: false })).rejects.toThrow(
      'usage_policy_unavailable'
    )
    expect(update).not.toHaveBeenCalled()
    expect(updateUI).not.toHaveBeenCalled()
    await expect(
      controller.update({ usageRequestEnabled: { claude: false }, machineName: 'ineffective' })
    ).rejects.toThrow('usage_policy_unavailable')
    expect(store.getSettings().machineName).not.toBe('ineffective')
    await expect(controller.update({ machineName: 'guest' })).resolves.toMatchObject({
      machineName: 'guest'
    })
  })

  it('refuses malformed RPC policy flags and leaves existing opt-outs untouched', async () => {
    const { store } = await fixture()
    const controller = hostController(store)
    await controller.update({ usageRequestEnabled: { claude: false } })
    expect(SettingsUpdate.safeParse({ usageRequestEnabled: { claude: 'false' } }).success).toBe(
      false
    )
    expect(SettingsUpdate.safeParse({ usageRequestEnabled: { antigravity: false } }).success).toBe(
      false
    )
    expect(SettingsUpdate.safeParse({ antigravityUsageEnabled: 'false' }).success).toBe(false)
    expect(controller.get().usageRequestEnabled).toEqual({ claude: false })
  })
})
