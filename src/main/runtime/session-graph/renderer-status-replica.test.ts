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
    reconcile(replica, members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 2, rows: [record('B', 'next')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    reconcile(replica, members('B'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('A', 'late')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 4, rows: [record('C', 'future')] })
    reconcile(replica, new Map())
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 5, rows: [record('B', 'closed')] })
    reconcile(replica, members('B'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    reconcile(replica, members('C'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
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
