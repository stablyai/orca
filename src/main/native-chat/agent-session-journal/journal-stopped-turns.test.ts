import { expect, it, vi } from 'vitest'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalTombstoneRow,
  buildJournalSubmissionRow
} from './journal-row-builders'
import { buildJournalStopEventRow } from './journal-stop-and-resume-rows'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { mergeItems } from '../../../shared/structured-agent-session-history-state'
import { selectStructuredAgentTurnBars } from '../../../shared/structured-agent-session-turn-timing'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { JournalStoppedTurns } from './journal-stopped-turns'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnItem,
  AgentJournalProducerLinkage,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { JournalStopEvent } from './journal-row-schema'

function rig(accepted = true) {
  const state = createJournalReducerState('session', 'epoch')
  const rows: Parameters<typeof applyJournalRow>[1][] = []
  const item = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    linkage?: AgentJournalProducerLinkage
  ) => {
    const row = buildJournalItemRow({
      state,
      identity,
      body,
      seq: state.lastSequence + 1,
      ts: 20_000 + state.lastSequence,
      fence: 1,
      linkage,
      turnScope: { kind: 'thread' }
    })
    applyJournalRow(state, row)
    rows.push(row)
    return state.items.get(agentJournalItemKey(identity))!
  }
  const stop = (turnId: string | undefined, reason: JournalStopEvent['reason'] = 'user-stop') => {
    const row = buildJournalStopEventRow({
      state,
      seq: state.lastSequence + 1,
      ts: 30_000,
      fence: 1,
      event: { reason, at: 30_000, ...(turnId ? { turnId } : {}) }
    })
    applyJournalRow(state, row)
    rows.push(row)
    return row
  }
  const accept = (clientMessageId = 'accepted', legacy = false) => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: clientMessageId }]
    }
    const submission = buildJournalSubmissionRow({
      state,
      clientMessageId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
      providerHandle: agentSessionJournalProviderHandle({
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }),
      fence: 1,
      seq: state.lastSequence + 1,
      ts: 1,
      ...(legacy ? {} : { handoverRecorded: true as const })
    })
    applyJournalRow(state, submission)
    rows.push(submission)
    const dispatch = {
      kind: 'dispatch',
      epoch: state.epoch,
      v: submission.v,
      seq: state.lastSequence + 1,
      ts: 2,
      fence: 1,
      clientMessageId,
      state: 'accepted',
      providerItemId: null,
      reason: null
    } as const
    applyJournalRow(state, dispatch)
    rows.push(dispatch)
  }
  if (accepted) {
    accept()
  }
  return { state, rows, item, stop, accept }
}
const identity = (name: string): AgentJournalItemIdentity => ({
  provider: 'legacy',
  agent: 'codex',
  sessionId: 'session',
  recordId: name
})
const failed = (turnId = 'T'): AgentJournalTurnItem => ({
  kind: 'turn',
  turnId,
  userItemId: agentJournalItemKey(identity('opener')),
  state: 'completed',
  outcome: 'failure',
  startedAt: 1_000,
  requestedAt: 800,
  completedAt: 4_000,
  durationMs: 3_000
})

it('reduces the exact historical result once, replays it, and publishes equal-revision items to older readers', () => {
  const r = rig()
  r.item(identity('opener'), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'go' }]
  })
  const before = r.item(identity('turn'), failed())
  const stop = r.stop('T')
  const cancelled = r.state.items.get(before.itemId)!
  expect(cancelled).toEqual({
    ...before,
    body: { ...failed(), state: 'interrupted', outcome: 'cancellation' }
  })
  expect(cancelled).not.toBe(before)
  const result = projectJournalBatch({
    rows: [stop],
    snapshot: renderJournalState(r.state),
    afterSequence: stop.seq - 1,
    stoppedTurnItemId: (id) => r.state.stoppedTurns.target(id)
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('missing projection')
  }
  const oldItems = mergeItems([before], result.batch.items, result.batch.removedItemIds)
  expect(oldItems).toEqual([cancelled])
  expect(
    selectStructuredAgentTurnBars(
      [r.state.items.get(agentJournalItemKey(identity('opener')))!, ...oldItems],
      [],
      null
    ).settledTurns.get(agentJournalItemKey(identity('opener')))
  ).toMatchObject({ workedSeconds: 3, verdict: 'cancellation' })
  const replay = createJournalReducerState('session', 'epoch')
  for (const row of r.rows) {
    applyJournalRow(replay, row)
  }
  expect(renderJournalState(replay)).toEqual(renderJournalState(r.state))
  expect(r.rows.find((row) => row.kind === 'item' && row.itemId === before.itemId)).toMatchObject({
    body: { state: 'completed', outcome: 'failure' }
  })
})

it.each(['ordinary-before-terminal', 'host-close', 'wrong-target', 'child'] as const)(
  'preserves explicit ordinary failure for %s',
  (kind) => {
    const r = rig()
    const id = identity('turn')
    if (kind === 'ordinary-before-terminal') {
      r.item(id, { kind: 'turn', turnId: 'T', state: 'running' })
      r.stop('T')
    }
    const failedItem = r.item(id, failed(), kind === 'child' ? { agentId: 'child' } : undefined)
    if (kind !== 'ordinary-before-terminal') {
      r.stop(
        kind === 'wrong-target' ? 'U' : 'T',
        kind === 'host-close' ? 'user-close' : 'user-stop'
      )
    }
    expect(r.state.items.get(failedItem.itemId)?.body).toMatchObject({ outcome: 'failure' })
  }
)

it('retires changed result proof without changing the original in-force retry-only action, including removal/re-add', () => {
  const r = rig()
  const t = r.item(identity('turn'), failed())
  const mark = r.stop('T')
  r.item(identity('new-turn'), { ...failed('U'), state: 'running', outcome: undefined })
  r.item(identity('turn'), { ...failed(), requestedAt: 850 })
  expect(r.state.items.get(t.itemId)?.body).toMatchObject({ outcome: 'failure', requestedAt: 850 })
  expect(r.state.stoppedTurns.target('T')).toBeUndefined()
  expect(r.state.stoppedTurns.namesStop(r.state, 'T', mark.seq)).toBe(true)
  const tombstone = buildJournalTombstoneRow({
    state: r.state,
    itemId: t.itemId,
    seq: r.state.lastSequence + 1,
    ts: 40_000,
    fence: 1
  })
  applyJournalRow(r.state, tombstone)
  expect(r.state.stoppedTurns.target('T')).toBeUndefined()
  expect(r.state.stoppedTurns.namesStop(r.state, 'T', mark.seq)).toBe(true)
  r.item(identity('turn'), failed())
  expect(r.state.items.get(t.itemId)?.body).toMatchObject({ outcome: 'failure' })
  r.stop('U')
  expect(r.state.stoppedTurns.namesStop(r.state, 'T', mark.seq)).toBe(false)
})

it('treats actual changed lifecycle as new truth while an ordinary cancellation keeps ordinary explicit-failure precedence', () => {
  const r = rig()
  const id = identity('turn')
  r.item(id, failed())
  r.stop('T')
  r.item(id, { ...failed(), state: 'running', outcome: undefined })
  r.item(id, { ...failed(), completedAt: 5_000, outcome: 'success' })
  expect(r.state.stoppedTurns.target('T')).toBeUndefined()
  r.item(id, { ...failed(), state: 'running', outcome: undefined })
  r.stop('T')
  r.item(id, { ...failed(), state: 'interrupted', outcome: 'cancellation' })
  r.item(id, failed())
  expect(r.state.items.get(agentJournalItemKey(id))?.body).toMatchObject({ outcome: 'failure' })
})

it('restates a retained settled cancellation without reconstructing Stop or execution provenance', () => {
  const r = rig()
  const id = identity('renamed-retained-turn')
  const retained = r.item(id, { ...failed(), state: 'interrupted', outcome: 'cancellation' })
  r.stop(undefined)
  expect(r.state.items.get(retained.itemId)?.body).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation'
  })
  expect(r.state.stoppedTurns.namesStop(r.state, 'T', r.state.lastSequence)).toBe(false)
  r.item(id, { ...failed(), requestedAt: 850 })
  expect(r.state.items.get(retained.itemId)?.body).toMatchObject({ outcome: 'failure' })
})

it.each([100, 1_000])(
  'bounds adoption and M real fold/publication triggers independently of %i retained turns',
  (population) => {
    const r = rig()
    const observe = vi.spyOn(JournalStoppedTurns.prototype, 'observe')
    const accept = vi.spyOn(JournalStoppedTurns.prototype, 'accept')
    const target = vi.spyOn(JournalStoppedTurns.prototype, 'target')
    try {
      for (let index = 0; index < population; index++) {
        r.item(identity(`root-${index}`), failed(`T-${index}`))
      }
      expect(observe).toHaveBeenCalledTimes(population)
      const roots = r.state.stoppedTurns['roots']
      const facts = r.state.stoppedTurns['stopped']
      const lookups = vi.spyOn(roots, 'get')
      const factLookups = vi.spyOn(facts, 'get')
      observe.mockClear()
      accept.mockClear()
      target.mockClear()
      for (let output = 0; output < 20; output++) {
        const mark = r.stop('T-0')
        r.item(identity('root-0'), {
          ...failed('T-0'),
          state: 'interrupted',
          outcome: 'cancellation',
          requestedAt: output + 1
        })
        const projected = projectJournalBatch({
          rows: [mark, r.rows.at(-1)!],
          snapshot: renderJournalState(r.state),
          afterSequence: mark.seq - 1,
          stoppedTurnItemId: (id) => r.state.stoppedTurns.target(id)
        })
        expect(projected.ok).toBe(true)
      }
      expect(observe).toHaveBeenCalledTimes(20)
      expect(accept).toHaveBeenCalledTimes(20)
      expect(target).toHaveBeenCalledTimes(20)
      expect(lookups.mock.calls.length + factLookups.mock.calls.length).toBeLessThanOrEqual(160)
      expect(roots.size).toBe(population)
      expect(facts.size).toBe(1)
      // Existing snapshots/sorts/indexes are deliberately outside the new derivation's operation bound.
      expect(renderJournalState(r.state).items).toHaveLength(population + 1)
    } finally {
      vi.restoreAllMocks()
    }
  }
)

it('never revisits an acceptance-free carried Stop when a legacy operational acceptance later arrives', () => {
  const r = rig(false)
  const old = r.item(identity('old'), failed('old'))
  const carried = r.stop('old')
  expect(r.state.hasAppliedProviderAcceptance).toBe(false)
  r.accept('legacy', true)
  expect(r.state.hasAppliedProviderAcceptance).toBe(true)
  expect(r.state.latestAcceptedTurnSequence).toBe(0)
  expect(r.state.items.get(old.itemId)?.body).toMatchObject({ outcome: 'failure' })
  expect(r.state.stoppedTurns.namesStop(r.state, 'old', carried.seq)).toBe(false)
  const fresh = r.item(identity('new'), failed('new'))
  r.stop('new')
  expect(r.state.items.get(fresh.itemId)?.body).toMatchObject({ outcome: 'cancellation' })
})

it.each(['dispatch', 'item', 'batch'] as const)(
  'only applied %s acceptance crosses the legacy materialization boundary',
  (route) => {
    const r = rig(false)
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'legacy input' }]
    }
    const submission = buildJournalSubmissionRow({
      state: r.state,
      clientMessageId: 'legacy',
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
      providerHandle: agentSessionJournalProviderHandle({
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }),
      fence: 1,
      seq: 1,
      ts: 1
    })
    applyJournalRow(r.state, submission)
    expect(r.state.hasAppliedProviderAcceptance).toBe(false)
    const echo = buildJournalItemRow({
      state: r.state,
      identity: { provider: 'codex', threadId: 'thread', turnId: 'legacy', ordinal: 0 },
      body,
      fence: 1,
      seq: 2,
      ts: 2,
      turnScope: { kind: 'thread' }
    })
    if (route === 'dispatch') {
      applyJournalRow(r.state, {
        kind: 'dispatch',
        v: submission.v,
        epoch: 'epoch',
        seq: 2,
        fence: 1,
        ts: 2,
        clientMessageId: 'legacy',
        state: 'accepted',
        providerItemId: null,
        reason: null
      })
    } else if (route === 'item') {
      applyJournalRow(r.state, echo)
    } else {
      applyJournalRow(r.state, {
        kind: 'lifecycle-batch',
        v: submission.v,
        epoch: 'epoch',
        seq: 2,
        fence: 1,
        ts: 2,
        settlementId: 'legacy-echo',
        mutations: [
          {
            kind: 'item',
            itemId: echo.itemId,
            revision: echo.revision,
            body,
            turnScope: { kind: 'thread' },
            ownerFence: 1
          }
        ]
      })
    }
    expect(r.state.submissions.get('legacy')?.dispatchState).toBe('accepted')
    expect(r.state.hasAppliedProviderAcceptance).toBe(true)
    expect(r.state.latestAcceptedTurnSequence).toBe(0)
  }
)

it.each([
  'absent',
  'rejected',
  'row-shaped-accepted',
  'own-echo',
  'stale-item',
  'duplicate-batch',
  'pending-dispatch',
  'unknown-dispatch'
] as const)('does not infer applied acceptance from %s', (control) => {
  const r = rig(false)
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'input' }]
  }
  const submission = buildJournalSubmissionRow({
    state: r.state,
    clientMessageId: 'input',
    body,
    payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
    providerHandle: agentSessionJournalProviderHandle({
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }),
    fence: 1,
    seq: 1,
    ts: 1
  })
  if (control !== 'absent') {
    applyJournalRow(r.state, submission)
  }
  const dispatch = {
    kind: 'dispatch',
    v: submission.v,
    epoch: 'epoch',
    seq: 2,
    fence: 1,
    ts: 2,
    clientMessageId: 'input',
    state: 'accepted',
    providerItemId: null,
    reason: null
  } as const
  if (control === 'rejected') {
    applyJournalRow(r.state, { ...dispatch, state: 'rejected' })
  }
  if (control === 'row-shaped-accepted') {
    r.state.submissions.get('input')!.dispatchState = 'accepted'
  }
  const echo = buildJournalItemRow({
    state: r.state,
    identity: { provider: 'codex', threadId: 'thread', turnId: 'input', ordinal: 0 },
    body,
    fence: 1,
    seq: 3,
    ts: 3,
    turnScope: { kind: 'thread' }
  })
  if (control === 'stale-item') {
    r.state.tombstones.set(echo.itemId, echo.revision)
  }
  if (control === 'own-echo') {
    applyJournalRow(r.state, { ...echo, echoOf: null })
  } else if (control === 'duplicate-batch') {
    r.state.appliedSettlementIds.add('duplicate')
    applyJournalRow(r.state, {
      kind: 'lifecycle-batch',
      v: submission.v,
      epoch: 'epoch',
      seq: 3,
      fence: 1,
      ts: 3,
      settlementId: 'duplicate',
      mutations: [
        {
          kind: 'item',
          itemId: echo.itemId,
          revision: echo.revision,
          body,
          turnScope: { kind: 'thread' },
          ownerFence: 1
        }
      ]
    })
  } else if (control === 'pending-dispatch' || control === 'unknown-dispatch') {
    applyJournalRow(r.state, {
      ...dispatch,
      state: control === 'pending-dispatch' ? 'pending' : 'unknown'
    })
  } else {
    applyJournalRow(r.state, echo)
    if (control === 'absent' || control === 'rejected' || control === 'row-shaped-accepted') {
      applyJournalRow(r.state, dispatch)
    }
  }
  expect(r.state.hasAppliedProviderAcceptance).toBe(false)
})
