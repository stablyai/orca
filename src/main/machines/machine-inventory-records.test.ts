import { describe, expect, it } from 'vitest'
import type { MachineProviderInventory, MachineRecord } from '../../shared/machine-inventory'
import { MAX_GONE_MACHINE_RECORDS, pruneGoneRecords } from './machine-inventory-records'

function record(id: string, overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id,
    name: id,
    lifetime: 'persistent',
    state: 'gone',
    createdAt: '2026-10-18T00:00:00Z',
    providerKey: 'plugin:acme.omarchy/omarchy',
    lastSeenAt: 0,
    ...overrides
  }
}

function inventory(machines: MachineRecord[]): MachineProviderInventory {
  return { machines, pendingCreates: [] }
}

describe('pruneGoneRecords', () => {
  it('keeps a gone row while any of its hosts is still referenced, and never touches live rows', () => {
    const inv = inventory([
      record('by-ssh', { sshTargetId: 'machine-a' }),
      record('by-managed', { managedEnvironmentId: 'env-b' }),
      record('by-runtime', { runtimeEnvironmentId: 'env-c' }),
      record('orphan', { managedEnvironmentId: 'env-gone' }),
      record('running', { state: 'running' })
    ])
    const referenced = new Set(['ssh:machine-a', 'runtime:env-b', 'runtime:env-c'])
    pruneGoneRecords(inv, (hostId) => referenced.has(hostId))
    expect(inv.machines.map((machine) => machine.id)).toEqual([
      'by-ssh',
      'by-managed',
      'by-runtime',
      'running'
    ])
  })

  it('caps referenced gone rows, dropping the oldest first', () => {
    const gone = Array.from({ length: MAX_GONE_MACHINE_RECORDS + 3 }, (_, index) =>
      record(`gone-${index}`, { sshTargetId: `machine-${index}`, lastSeenAt: index })
    )
    const inv = inventory([...gone, record('running', { state: 'running' })])
    pruneGoneRecords(inv, () => true)
    const kept = inv.machines.map((machine) => machine.id)
    expect(kept).toHaveLength(MAX_GONE_MACHINE_RECORDS + 1)
    expect(kept).not.toContain('gone-0')
    expect(kept).not.toContain('gone-2')
    expect(kept).toContain('gone-3')
    expect(kept).toContain('running')
  })
})
