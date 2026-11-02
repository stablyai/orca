import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRows = vi.hoisted(() => new Map<string, { enabled: boolean; updatedAt: number }>())
const updates = vi.hoisted((): string[] => [])
const failNextUpdate = vi.hoisted(() => ({ value: false }))
const throwOnUpdate = vi.hoisted(() => ({ value: false }))
const updateAttempts = vi.hoisted(() => ({ count: 0 }))
const failOnUpdateOf = vi.hoisted((): { id: string | null; thenAlso: string | null } => ({
  id: null,
  thenAlso: null
}))

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
    params: { id: string; updates?: { enabled: boolean } }
  ) => {
    const row = hostRows.get(params.id)
    if (method === 'automation.show') {
      return row
        ? { ok: true, result: { automation: row } }
        : { ok: false, error: { message: 'Automation not found.' } }
    }
    updateAttempts.count++
    if (throwOnUpdate.value) {
      throw new Error('connect ECONNREFUSED')
    }
    if (failNextUpdate.value || failOnUpdateOf.id === params.id) {
      failNextUpdate.value = false
      // Then the host drops: the next update (turning one back on) fails too.
      failOnUpdateOf.id = failOnUpdateOf.thenAlso
      failOnUpdateOf.thenAlso = null
      return { ok: false, error: { message: 'busy' } }
    }
    updates.push(params.id)
    if (row) {
      row.enabled = params.updates?.enabled ?? true
    }
    return { ok: true, result: {} }
  }
}))

import { enableWslHostAutomations } from './wsl-host-automation-enable'
import { disableWslHostAutomations, restoreWslHostAutomations } from './wsl-host-automation-disable'

beforeEach(() => {
  hostRows.clear()
  updates.length = 0
  throwOnUpdate.value = false
  updateAttempts.count = 0
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
})

describe('undo on the host', () => {
  it('turns back on what it turned off before throwing, so a refused undo changes nothing', async () => {
    hostRows.set('a', { enabled: true, updatedAt: 1 })
    hostRows.set('b', { enabled: true, updatedAt: 1 })
    failOnUpdateOf.id = 'b'
    await expect(disableWslHostAutomations('/user-data', 'wsl:Ubuntu', ['a', 'b'])).rejects.toThrow(
      'wsl_move_automation_disable_failed:busy'
    )
    expect(hostRows.get('a')?.enabled).toBe(true)
    expect(hostRows.get('b')?.enabled).toBe(true)
  })

  it('carries what it could not turn back on on the error', async () => {
    hostRows.set('a', { enabled: true, updatedAt: 1 })
    hostRows.set('b', { enabled: true, updatedAt: 1 })
    failOnUpdateOf.id = 'b'
    failOnUpdateOf.thenAlso = 'a'
    const error = await disableWslHostAutomations('/user-data', 'wsl:Ubuntu', ['a', 'b']).catch(
      (thrown: unknown) => thrown
    )
    expect(error).toMatchObject({ leftOff: ['a'] })
    expect(hostRows.get('a')?.enabled).toBe(false)
  })

  it('stops at a host that stops answering, leaving the rest off rather than wait on each', async () => {
    for (const id of ['a', 'b', 'c']) {
      hostRows.set(id, { enabled: false, updatedAt: 1 })
    }
    throwOnUpdate.value = true
    const error = await restoreWslHostAutomations('/user-data', 'wsl:Ubuntu', [
      'a',
      'b',
      'c'
    ]).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ leftOff: ['a', 'b', 'c'] })
    expect(updateAttempts.count).toBe(1)
  })
})
