import { describe, expect, it } from 'vitest'
import { createAgentStatusStore } from '../../../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import {
  StructuredCommandDetailSlots,
  type StructuredChildWorkAuthority
} from './structured-command-detail-slots'
import {
  createStructuredCommandOccurrence,
  endStructuredCommandOccurrence,
  markLiveEvidenceOccurrence,
  type StructuredCommandOccurrence
} from './structured-command-occurrence'

const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: '/w', workspaceKind: 'folder' },
  '11111111-1111-4111-8111-111111111111'
)

function harness() {
  const slots = new StructuredCommandDetailSlots()
  const store = createAgentStatusStore({
    epoch: 'command-detail-slots',
    mode: 'authority',
    onChildrenCommitted: slots.committed
  })
  store.applyMutation({ parent: { subject: parent } })
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const deliver = (evidence: AgentChildWorkEvidence[], authority?: StructuredChildWorkAuthority) =>
    reconcileAgentChildWorkEvidence({
      store,
      admission,
      parent,
      provider: 'codex',
      evidence,
      liveAdmission: slots.observer((id) => store.getChild(id), authority)
    })
  const record = () => store.getChildren(parent)[0] ?? null
  const slot = () => {
    const child = record()
    return child ? slots.read(store.getChild(child.childWorkId)!) : undefined
  }
  return { slots, store, deliver, record, slot }
}

function live(
  occurrence: StructuredCommandOccurrence | null,
  options: { id?: string; kind?: 'command' | 'agent'; observedAt?: number; runId?: string } = {}
): AgentChildWorkEvidence {
  const child: AgentChildWorkLiveObservation = {
    handle: {
      idKind: 'task_id',
      id: options.id ?? 'codex-command:primary:call-1',
      ...(options.runId ? { runId: options.runId } : {})
    },
    kind: options.kind ?? 'command',
    residency: 'background',
    state: 'working',
    description: 'pnpm test',
    stoppable: true
  }
  if (occurrence) {
    markLiveEvidenceOccurrence(child, new WeakRef(occurrence))
  }
  return { type: 'live', observedAt: options.observedAt ?? 10, child }
}

const removed = (id = 'codex-command:primary:call-1'): AgentChildWorkEvidence => ({
  type: 'removed',
  observedAt: 20,
  handle: { idKind: 'task_id', id }
})

describe('structured command detail slots', () => {
  it('binds the exact command once, at the first creating admission from a current producer', () => {
    const h = harness()
    const occurrence = createStructuredCommandOccurrence('pnpm test --run')
    h.deliver([live(occurrence)], { fence: 4 })
    expect(h.slot()).toMatchObject({ fence: 4, display: 'pnpm test --run' })
    expect(occurrence.seen).toBe(true)
  })

  it('binds nothing without producer authority, exact text, or an active occurrence', () => {
    const noAuthority = harness()
    noAuthority.deliver([live(createStructuredCommandOccurrence('ls'))])
    expect(noAuthority.slot()).toBeUndefined()
    const noText = harness()
    noText.deliver([live(createStructuredCommandOccurrence(null))], { fence: 1 })
    expect(noText.slot()).toBeUndefined()
    const ended = harness()
    const occurrence = createStructuredCommandOccurrence('ls')
    endStructuredCommandOccurrence(occurrence)
    ended.deliver([live(occurrence)], { fence: 1 })
    expect(ended.slot()).toBeUndefined()
    const unmarked = harness()
    unmarked.deliver([live(null)], { fence: 1 })
    expect(unmarked.slot()).toBeUndefined()
  })

  it('keeps the bytes through same-occurrence restatements and settlement-safe updates', () => {
    const h = harness()
    const occurrence = createStructuredCommandOccurrence('make all')
    h.deliver([live(occurrence)], { fence: 2 })
    const first = h.record()
    h.deliver([live(occurrence, { observedAt: 30 })], { fence: 2 })
    expect(h.record()).not.toBe(first)
    expect(h.slot()?.display).toBe('make all')
  })

  it('a later live update from another occurrence, another fence or no proof revokes; nothing refills', () => {
    for (const later of [
      () => [[live(createStructuredCommandOccurrence('rm -rf x'))], { fence: 2 }] as const,
      (o: StructuredCommandOccurrence) => [[live(o)], { fence: 3 }] as const,
      (o: StructuredCommandOccurrence) => [[live(o)], undefined] as const,
      () => [[live(null)], { fence: 2 }] as const
    ]) {
      const h = harness()
      const occurrence = createStructuredCommandOccurrence('make all')
      h.deliver([live(occurrence)], { fence: 2 })
      const [evidence, authority] = later(occurrence)
      h.deliver([...evidence], authority)
      expect(h.slot()).toBeUndefined()
      h.deliver([live(occurrence, { observedAt: 40 })], { fence: 2 })
      expect(h.slot()).toBeUndefined()
    }
  })

  it('a removed record drops its slot, and a reused id never inherits it', () => {
    const h = harness()
    const first = createStructuredCommandOccurrence('first')
    h.deliver([live(first)], { fence: 1 })
    h.deliver([removed()], { fence: 1 })
    expect(h.record()).toBeNull()
    // The same provider id comes back retired: a later generation, never bound.
    const second = createStructuredCommandOccurrence('second')
    h.deliver([live(second, { observedAt: 50 })], { fence: 1 })
    expect(h.record()?.invocation.generation).toBe(2)
    expect(h.slot()).toBeUndefined()
    expect(second.retirementObserved).toBe(true)
  })

  it('§P: a known-retired occurrence stays denied even when a later restatement creates', () => {
    const h = harness()
    h.deliver([live(createStructuredCommandOccurrence('old'))], { fence: 1 })
    h.deliver([removed()], { fence: 1 })
    const retired = createStructuredCommandOccurrence('new')
    // Its first resolution sees the retired binding, whatever admission does next.
    h.deliver([live(retired, { observedAt: 60 })], { fence: 1 })
    expect(retired.retirementObserved).toBe(true)
    expect(h.slot()).toBeUndefined()
  })

  it('§P: an unretired occurrence refused first keeps its one attach for a later creation', () => {
    const h = harness()
    const occurrence = createStructuredCommandOccurrence('echo ok')
    // Refused as invalid after a resolution that saw no retirement: nothing is admitted.
    const refused = h.deliver([live(occurrence, { kind: 'bogus' as never })], { fence: 1 })
    expect(refused.rejected).toHaveLength(1)
    expect(h.record()).toBeNull()
    expect(occurrence.seen).toBe(false)
    expect(occurrence.retirementObserved).toBe(false)
    h.deliver([live(occurrence)], { fence: 1 })
    expect(h.slot()?.display).toBe('echo ok')
  })

  it('reclassification and a new invocation drop the slot at the commit boundary', () => {
    const h = harness()
    const occurrence = createStructuredCommandOccurrence('sleep 100')
    h.deliver([live(occurrence)], { fence: 1 })
    h.deliver([live(occurrence, { kind: 'agent', observedAt: 20 })], { fence: 1 })
    expect(h.slot()).toBeUndefined()
    const resumed = harness()
    const run = createStructuredCommandOccurrence('sleep 100')
    resumed.deliver([live(run, { runId: 'turn-1' })], { fence: 1 })
    expect(resumed.slot()).toBeDefined()
    resumed.deliver([live(run, { runId: 'turn-2', observedAt: 30 })], { fence: 1 })
    expect(resumed.record()?.invocation.generation).toBe(2)
    expect(resumed.slot()).toBeUndefined()
  })

  it('exports and restores never carry the command', () => {
    const h = harness()
    h.deliver([live(createStructuredCommandOccurrence('secret-free but private'))], { fence: 1 })
    const snapshot = JSON.stringify(h.store.getSnapshot())
    expect(snapshot).not.toContain('secret-free but private')
    const slots = new StructuredCommandDetailSlots()
    const restored = createAgentStatusStore({
      epoch: 'restored',
      mode: 'authority',
      onChildrenCommitted: slots.committed
    })
    expect(restored.applySnapshot(JSON.parse(snapshot))).toBe(true)
    const child = restored.getChildren(parent)[0]!
    expect(slots.read(restored.getChild(child.childWorkId)!)).toBeUndefined()
  })
})
