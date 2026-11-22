import { afterEach, describe, expect, it } from 'vitest'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const lanes = new Set<AcpTimelineTranslator>()

afterEach(() => {
  for (const lane of lanes) {
    lane.dispose()
  }
  lanes.clear()
})

function compact() {
  const lane = new AcpTimelineTranslator({
    sessionId: 'session',
    dialect: OPENCODE_ACP_DIALECT,
    agentName: 'OpenCode'
  })
  lanes.add(lane)
  lane.openPrompt('request', 1, 'compact:request')
  return lane
}

function notify(lane: AcpTimelineTranslator, update: SessionUpdate) {
  return lane.notification('session/update', { sessionId: 'session', update }, 2)
}

function marker(
  status: 'started' | 'completed' | 'failed',
  error?: { type: string; message?: string }
): SessionUpdate {
  return {
    sessionUpdate: 'session_info_update',
    _meta: {
      'opencode/compaction': { status, messageId: 'operation', reason: 'manual', error }
    }
  }
}

function settle(
  lane: AcpTimelineTranslator,
  stopReason = 'end_turn',
  cancelRequested = false,
  request = 'request'
) {
  const events = lane.promptResult(request, { stopReason }, 3, cancelRequested)
  const end = events.find((event) => event.type === 'turn.end')
  return {
    state: end?.state,
    outcome: end?.outcome,
    rows: events.flatMap((event) =>
      (event.type === 'item.close' || event.type === 'item.update') && event.body?.kind === 'status'
        ? [event.body.failure ?? { presentation: event.body.presentation }]
        : []
    )
  }
}

describe('ACP command compaction settlement', () => {
  it('retains a standard compaction failure despite a successful prompt response', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'in_progress'
    })
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'failed',
      error: 'Cannot summarize this context'
    })
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'failure',
      rows: [
        {
          kind: 'compactionFailed',
          detail: { text: 'Cannot summarize this context', audience: 'person' }
        }
      ]
    })
  })

  it('does not require the optional diagnostic to recognize a failed compaction', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'failed',
      error: null
    })
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'failure',
      rows: [{ kind: 'compactionFailed' }]
    })
  })

  it('settles the OpenCode fallback failure marker as a failed command', () => {
    const lane = compact()
    notify(lane, marker('started'))
    notify(
      lane,
      marker('failed', { type: 'compaction.failed', message: 'Cannot summarize this context' })
    )
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'failure',
      rows: [
        {
          kind: 'compactionFailed',
          detail: { text: 'Cannot summarize this context', audience: 'person' }
        }
      ]
    })
  })

  it('settles standard cancellation without a successful compaction row', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'cancelled'
    })
    expect(settle(lane)).toEqual({ state: 'interrupted', outcome: 'cancellation', rows: [] })
  })

  it.each(['aborted', 'compaction.interrupted'])(
    'recognizes OpenCode fallback cancellation %s',
    (type) => {
      const lane = compact()
      notify(lane, marker('started'))
      notify(lane, marker('failed', { type, message: 'Compaction cancelled' }))
      expect(settle(lane)).toEqual({ state: 'interrupted', outcome: 'cancellation', rows: [] })
    }
  )

  it('keeps completed compaction successful when Stop arrives after its completion', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'completed'
    })
    expect(settle(lane, 'cancelled', true)).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
  })

  it('accepts a completed OpenCode fallback compaction', () => {
    const lane = compact()
    notify(lane, marker('started'))
    notify(lane, marker('completed'))
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
  })

  it('does not infer completion from a partial compaction summary', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'operation',
      content: { type: 'text', text: 'Partial summary' }
    })
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'failure',
      rows: [{ kind: 'compactionUnconfirmed' }]
    })
  })

  it('honors Stop even when the agent answers end_turn without confirming compaction', () => {
    const lane = compact()
    expect(settle(lane, 'end_turn', true)).toEqual({
      state: 'interrupted',
      outcome: 'cancellation',
      rows: []
    })
  })

  it('does not let another operation complete the active compaction', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'in_progress'
    })
    notify(lane, { sessionUpdate: 'compaction_update', compactionId: 'other', status: 'completed' })
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'failed'
    })
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'failure',
      rows: [{ kind: 'compactionFailed' }]
    })
  })

  it('does not rebind an old operation after intervening prompts', () => {
    const lane = compact()
    notify(lane, marker('started'))
    notify(lane, marker('completed'))
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
    lane.openPrompt('intervening', 4)
    lane.promptResult('intervening', { stopReason: 'end_turn' }, 5)
    lane.openPrompt('next', 6, 'compact:next')
    notify(lane, marker('failed', { type: 'compaction.failed', message: 'Late old failure' }))
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'next-operation',
      status: 'completed'
    })
    expect(settle(lane, 'end_turn', false, 'next')).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
  })

  it('ignores replayed and child compactions before binding a root operation', () => {
    const lane = compact()
    const update: SessionUpdate = {
      sessionUpdate: 'compaction_update',
      compactionId: 'unrelated',
      status: 'failed'
    }
    lane.notification(
      'session/update',
      { sessionId: 'session', _meta: { isReplay: true }, update },
      2
    )
    lane.notification('session/update', { sessionId: 'child', update }, 2)
    lane.notification(
      'opencode/session/child_update',
      {
        type: 'update',
        rootSessionId: 'session',
        parentSessionId: 'session',
        childSessionId: 'child',
        update
      },
      2
    )
    notify(lane, {
      sessionUpdate: 'compaction_update',
      compactionId: 'operation',
      status: 'completed'
    })
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
  })

  it('does not attribute an automatic OpenCode compaction to the manual command', () => {
    const lane = compact()
    notify(lane, {
      sessionUpdate: 'session_info_update',
      _meta: { 'opencode/compaction': { status: 'failed', messageId: 'auto', reason: 'auto' } }
    })
    notify(lane, marker('completed'))
    expect(settle(lane)).toEqual({
      state: 'completed',
      outcome: 'success',
      rows: [{ presentation: 'compaction' }]
    })
  })
})
