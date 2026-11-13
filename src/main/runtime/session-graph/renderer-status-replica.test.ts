import { describe, expect, it } from 'vitest'
import { RendererStatusReplica, type RendererStatusMember } from './renderer-status-replica'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'

const row: AgentStatusEntry = {
  paneKey: 'tab:leaf',
  state: 'working',
  prompt: 'Build it',
  stateStartedAt: 10,
  updatedAt: 20,
  stateHistory: []
}
const member = (pty: string | null, title = 'Claude'): RendererStatusMember => ({
  paneKey: 'tab:leaf',
  leafId: 'leaf',
  rendererPtyId: pty,
  worktreeId: 'workspace',
  statusSuppressionTitle: title
})
const members = (pty: string | null, title?: string) => new Map([['tab:leaf', member(pty, title)]])
const record = (pty: string | null, prompt: string) => ({ ...member(pty), row: { ...row, prompt } })

function reconcile(replica: RendererStatusReplica, incoming: Map<string, RendererStatusMember>) {
  return replica.reconcileGraph(incoming, new Set(['workspace']))
}

describe('renderer status / graph join', () => {
  it('joins an initial snapshot and an incoming occupant without reviving the retired occupant', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 1, rows: [record('A', 'first')] })
    expect(replica.get('tab:leaf')).toBeUndefined()
    const control = { ...member('control'), paneKey: 'control:leaf', worktreeId: 'other' }
    replica.reconcileGraph(
      new Map([...members('A'), ['control:leaf', control]]),
      new Set(['workspace', 'other'])
    )
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: 2,
      rows: [{ ...control, row: { ...row, paneKey: 'control:leaf', prompt: 'untouched' } }]
    })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('B', 'next')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    reconcile(replica, members('B'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 4, rows: [record('A', 'late')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 5, rows: [record('C', 'future')] })
    reconcile(replica, new Map())
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 6, rows: [record('B', 'closed')] })
    reconcile(replica, members('B'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    reconcile(replica, members('C'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    expect(replica.get('control:leaf')?.row?.prompt).toBe('untouched')
  })

  it('preserves unbound and remounted rows and re-shapes title changes without another status write', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    reconcile(replica, members(null))
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 1, rows: [record(null, 'unbound')] })
    reconcile(replica, members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('unbound')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 2, rows: [record('A', 'bound')] })
    reconcile(replica, members(null))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    reconcile(replica, members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    reconcile(replica, members('A', 'claude agents'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    reconcile(replica, members('A', 'Claude'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    reconcile(replica, members(null))
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('B', 'bound')] })
    reconcile(replica, members('B'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
  })

  it('requests a replacement snapshot on pending overflow while retaining the newest future occupant', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    const overflow = replica.apply({
      type: 'snapshot',
      epoch: 'renderer',
      seq: 1,
      rows: Array.from({ length: 2049 }, (_, index) => record(`future-${index}`, `turn-${index}`))
    })
    expect(overflow).toMatchObject({ accepted: true, snapshotRequired: true })
    reconcile(replica, members('future-0'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    reconcile(replica, members('future-2048'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('turn-2048')
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 2, rows: [] })
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
  })

  it('requires a snapshot on a gap and replaces only the current publisher scope', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    reconcile(replica, members('A'))
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 1, rows: [record('A', 'first')] })
    expect(
      replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('A', 'gap')] })
    ).toMatchObject({ accepted: false, snapshotRequired: true })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 4, rows: [] })
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    replica.beginEpoch('replacement')
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 5, rows: [record('A', 'old')] })
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    reconcile(replica, members(null))
    replica.apply({
      type: 'snapshot',
      epoch: 'replacement',
      seq: 1,
      rows: [record(null, 'current')]
    })
    reconcile(replica, members('Y'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('current')
  })
})

// The resource bound is a requested regression contract, including recovery debt.
it.each([100, 1000])('releases retirement debt across 20 turnover cycles at %i panes', (width) => {
  const replica = new RendererStatusReplica()
  replica.beginEpoch('renderer')
  let seq = 0
  replica.apply({ type: 'snapshot', epoch: 'renderer', seq: ++seq, rows: [] })
  for (let cycle = 0; cycle < 20; cycle++) {
    const fleet = new Map(
      Array.from({ length: width }, (_, index) => {
        const item = { ...member(`A-${cycle}`), paneKey: `tab-${cycle}-${index}:leaf` }
        return [item.paneKey, item] as const
      })
    )
    reconcile(replica, fleet)
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: [...fleet.values()].map((item) => ({ ...item, row }))
    })
    const future = [...fleet.values()].map((item) => ({
      ...item,
      rendererPtyId: `B-${cycle}`,
      row: { ...row, prompt: 'future' }
    }))
    replica.apply({ type: 'changes', epoch: 'renderer', seq: ++seq, rows: future })
    reconcile(replica, new Map(future.map((item) => [item.paneKey, item])))
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: [...fleet.values()].map((item) => ({ ...item, row: { ...row, prompt: 'late' } }))
    })
    for (const item of fleet.values()) {
      expect(replica.get(item.paneKey)?.row?.prompt).toBe('future')
    }
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: [...fleet.values()].map((item) => ({ ...item, row: null }))
    })
    expect(replica).toHaveProperty('retired.size', 0)
    reconcile(replica, new Map())
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: future.map((item) => ({ ...item, row: null }))
    })
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: ++seq, rows: [] })
    for (const table of [
      'retired',
      'rows',
      'pending',
      'pendingByPane',
      'members',
      'membersByWorktree',
      'active',
      'bound'
    ]) {
      expect(replica).toHaveProperty(`${table}.size`, 0)
    }
  }
})

it.each([100, 1000])(
  'settles healthy close debt without snapshots at %i panes, in either graph order',
  (width) => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    let seq = 0
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: ++seq, rows: [] })
    for (let cycle = 0; cycle < 20; cycle++) {
      const fleet = new Map(
        Array.from({ length: width }, (_, index) => {
          const item = { ...member(`A-${cycle}`), paneKey: `tab-${cycle}-${index}:leaf` }
          return [item.paneKey, item] as const
        })
      )
      reconcile(replica, fleet)
      const rows = [...fleet.values()].map((item) => ({
        ...item,
        row: { ...row, paneKey: item.paneKey }
      }))
      const tombstones = rows.map((item) => ({ ...item, row: null }))
      replica.apply({
        type: 'changes',
        epoch: 'renderer',
        seq: ++seq,
        rows: rows.map((item) => ({ ...item, rendererPtyId: null }))
      })
      replica.apply({ type: 'changes', epoch: 'renderer', seq: ++seq, rows })
      expect(replica).toHaveProperty('rows.size', width)
      if (cycle % 2 === 0) {
        reconcile(replica, new Map())
        replica.apply({ type: 'changes', epoch: 'renderer', seq: ++seq, rows: tombstones })
      } else {
        replica.apply({ type: 'changes', epoch: 'renderer', seq: ++seq, rows: tombstones })
        reconcile(replica, new Map())
      }
      for (const table of [
        'retired',
        'rows',
        'pending',
        'pendingByPane',
        'members',
        'membersByWorktree',
        'active',
        'bound'
      ]) {
        expect(replica).toHaveProperty(`${table}.size`, 0)
      }
    }
    reconcile(replica, members(null))
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: [record(null, 'unbound')]
    })
    reconcile(replica, members('A'))
    reconcile(replica, new Map())
    replica.apply({
      type: 'changes',
      epoch: 'renderer',
      seq: ++seq,
      rows: [{ ...record('A', ''), row: null }]
    })
    expect(replica).toHaveProperty('retired.size', 0)
  }
)
