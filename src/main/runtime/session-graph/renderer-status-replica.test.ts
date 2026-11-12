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

describe('renderer status / graph join', () => {
  it('joins an initial snapshot and an incoming occupant without reviving the retired occupant', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 1, rows: [record('A', 'first')] })
    expect(replica.get('tab:leaf')).toBeUndefined()
    replica.reconcile(members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 2, rows: [record('B', 'next')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('first')
    replica.reconcile(members('B'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('A', 'late')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('next')
    replica.reconcile(new Map())
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 4, rows: [record('B', 'closed')] })
    replica.reconcile(members('B'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
  })

  it('preserves unbound and remounted rows and re-shapes title changes without another status write', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    replica.reconcile(members(null))
    replica.apply({ type: 'snapshot', epoch: 'renderer', seq: 1, rows: [record(null, 'unbound')] })
    replica.reconcile(members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('unbound')
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 2, rows: [record('A', 'bound')] })
    replica.reconcile(members(null))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    replica.reconcile(members('A'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    replica.reconcile(members('A', 'claude agents'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    replica.reconcile(members('A', 'Claude'))
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
    replica.reconcile(members('B'))
    expect(replica.get('tab:leaf')?.row).toBeUndefined()
    replica.apply({ type: 'changes', epoch: 'renderer', seq: 3, rows: [record('B', 'bound')] })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('bound')
  })

  it('requires a snapshot on a gap and replaces only the current publisher scope', () => {
    const replica = new RendererStatusReplica()
    replica.beginEpoch('renderer')
    replica.reconcile(members('A'))
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
    replica.apply({
      type: 'snapshot',
      epoch: 'replacement',
      seq: 1,
      rows: [record('A', 'current')]
    })
    expect(replica.get('tab:leaf')?.row?.prompt).toBe('current')
  })
})
