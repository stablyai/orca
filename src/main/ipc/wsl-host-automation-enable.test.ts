import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRows = vi.hoisted(() => new Map<string, { enabled: boolean; updatedAt: number }>())
const updates = vi.hoisted((): string[] => [])
const failNextUpdate = vi.hoisted(() => ({ value: false }))

vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => ({
    recordForEnvironment: () => ({ distro: 'Ubuntu' }),
    ensureForRuntimeCall: async () => {}
  })
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'wsl:Ubuntu', runtimeId: 'rt-1' })
}))
vi.mock('../../shared/runtime-environments', () => ({ getPreferredPairingOffer: () => ({}) }))
vi.mock('../../shared/pairing', () => ({
  encodePairingOffer: () => 'code',
  parsePairingCode: () => ({ code: 'code' })
}))
vi.mock('../ssh/orcad-migration-catalog-client', () => ({
  sendSupportedMigrationRequest: async (
    _pairing: unknown,
    method: string,
    params: { id: string }
  ) => {
    const row = hostRows.get(params.id)
    if (method === 'automation.show') {
      return row
        ? { ok: true, result: { automation: row } }
        : { ok: false, error: { message: 'Automation not found.' } }
    }
    if (failNextUpdate.value) {
      failNextUpdate.value = false
      return { ok: false, error: { message: 'busy' } }
    }
    updates.push(params.id)
    if (row) {
      row.enabled = true
    }
    return { ok: true, result: {} }
  }
}))

import { enableWslHostAutomations } from './wsl-host-automation-enable'

beforeEach(() => {
  hostRows.clear()
  updates.length = 0
})

describe('enableWslHostAutomations', () => {
  it('turns on only automations still exactly as the move left them', async () => {
    hostRows.set('untouched', { enabled: false, updatedAt: 10 })
    hostRows.set('edited-on-host', { enabled: false, updatedAt: 99 })
    hostRows.set('already-on', { enabled: true, updatedAt: 10 })
    await enableWslHostAutomations('/user-data', 'wsl:Ubuntu', [
      { id: 'untouched', updatedAt: 10 },
      { id: 'edited-on-host', updatedAt: 10 },
      { id: 'already-on', updatedAt: 10 },
      { id: 'deleted-on-host', updatedAt: 10 }
    ])
    expect(updates).toEqual(['untouched'])
  })

  it('throws when the host refuses one, so the step stays pending and retries', async () => {
    hostRows.set('a', { enabled: false, updatedAt: 1 })
    failNextUpdate.value = true
    await expect(
      enableWslHostAutomations('/user-data', 'wsl:Ubuntu', [{ id: 'a', updatedAt: 1 }])
    ).rejects.toThrow('wsl_move_automation_enable_failed:busy')
    await enableWslHostAutomations('/user-data', 'wsl:Ubuntu', [{ id: 'a', updatedAt: 1 }])
    expect(updates).toEqual(['a'])
  })
})
