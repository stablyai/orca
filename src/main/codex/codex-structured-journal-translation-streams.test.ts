import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { CodexTurnOrdinals } from './codex-structured-item-translation'
import {
  createCodexJournalTranslator,
  MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES,
  MAX_CODEX_GENERIC_ROWS_PER_TURN,
  MAX_CODEX_GENERIC_TURN_BUCKETS
} from './codex-structured-journal-translation'
import { CODEX_COMMAND_APPROVAL_METHOD } from './codex-structured-prompt-replies'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const bound: [string, string, string][] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {
      publishes += 1
    }
  }
  return {
    sink,
    rows,
    tombstones,
    bound,
    publishes: () => publishes,
    bindPromptItemId: (journalItemId: string, threadId: string, promptKey: string) =>
      bound.push([journalItemId, threadId, promptKey])
  }
}

/** Fires the coalescing window on demand instead of on wall time. */
function manualWindow() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const index = pending.indexOf(run)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const run of due) {
        run()
      }
    },
    idle: () => pending.length === 0
  }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

const TURN_STARTED = notification('turn/started', { turn: { id: TURN_ID } })

function translatorWith(tap = recorder(), window = manualWindow()) {
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    bindPromptItemId: tap.bindPromptItemId,
    schedule: window.schedule
  })
  return { translator, tap, window }
}

describe('codex journal translation', () => {
  it('retains active state when eviction settlement is backpressured', () => {
    const { translator, tap } = translatorWith()
    let rejectTerminal = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (identity, body, blobs, options) => {
      if (rejectTerminal && body.kind === 'tool-call' && body.state === 'failed') {
        return { accepted: false as const, reason: 'backpressure' as const }
      }
      appendItem(identity, body, blobs, options)
      return { accepted: true as const }
    }
    for (let index = 0; index <= 256; index += 1) {
      const result = translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: `evict-${index}`,
            command: 'run',
            status: 'inProgress'
          }
        })
      )
      if (index === 256) {
        expect(result).toEqual({ accepted: false, reason: 'backpressure' })
      }
    }
    rejectTerminal = false
    expect(
      translator.handle(
        notification('item/started', {
          item: {
            type: 'commandExecution',
            id: 'evict-retry',
            command: 'run',
            status: 'inProgress'
          }
        })
      )
    ).toEqual({ accepted: true })
    expect(
      tap.rows.filter((row) => row.body.kind === 'tool-call' && row.body.state === 'failed').length
    ).toBeGreaterThan(0)
  })

  it('terminalizes evicted pending prompts instead of silently forgetting them', () => {
    const { translator, tap } = translatorWith()
    translator.handle(TURN_STARTED)
    for (let index = 0; index <= 128; index += 1) {
      expect(
        translator.handle({
          type: 'prompt',
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          method: CODEX_COMMAND_APPROVAL_METHOD,
          params: {},
          codexItemId: `prompt-item-${index}`,
          promptKey: `prompt-${index}`
        })
      ).toEqual({ accepted: true })
    }
    expect(
      tap.rows.some(
        (row) => row.body.kind === 'approval' && row.body.resolution.state === 'cancelled'
      )
    ).toBe(true)
  })

  it('publishes after every write so a subscriber never trails the journal', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-0', text: 'hi' } })
    )

    expect(tap.publishes()).toBe(1)
  })

  it('releases a turn ordinal map when the turn completes', () => {
    const spy = vi.spyOn(CodexTurnOrdinals.prototype, 'forgetTurn')
    try {
      const { translator } = translatorWith()
      translator.handle(TURN_STARTED)
      translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
      expect(spy).toHaveBeenCalledWith(THREAD_ID, TURN_ID)
    } finally {
      spy.mockRestore()
    }
  })

  it('journals malformed item events but never malformed deltas', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(notification('item/completed', {}))
    translator.handle(notification('item/agentMessage/delta', { delta: 'orphan' }))
    window.fire()

    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({
        kind: 'status',
        providerFrame: expect.objectContaining({ kind: 'notification:item/completed' })
      })
    ])
  })

  it('journals unknown notifications, server requests, and decoded provider frames', () => {
    const { translator, tap } = translatorWith()

    translator.handle(notification('future/notification', { value: 1 }))
    translator.handle({
      type: 'server-request',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: 'future/request',
      params: { value: 2 }
    })
    translator.handle({
      type: 'provider-frame',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      kind: 'frame:unclassified',
      payload: { value: 3 }
    })

    expect(
      tap.rows.map((row) => (row.body.kind === 'status' ? row.body.providerFrame?.kind : undefined))
    ).toEqual(['notification:future/notification', 'request:future/request', 'frame:unclassified'])
  })

  it('terminalizes the active streamed item when an oversized notification is rejected', () => {
    const { translator, tap } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'exec-oversized',
          command: 'run',
          status: 'inProgress'
        }
      })
    )
    const admission = translator.handle({
      type: 'provider-frame',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      kind: 'frame:oversized-notification',
      payload: {
        reason: 'record-too-large',
        observedBytes: 20 * 1024 * 1024,
        maxBytes: 16 * 1024 * 1024,
        classification: 'notification',
        method: 'item/commandExecution/outputDelta'
      }
    })

    expect(admission).toEqual({ accepted: true })
    expect(tap.rows).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'tool-call', state: 'running' })
      }),
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'tool-call', state: 'failed' })
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'status',
          providerFrame: expect.objectContaining({ kind: 'frame:oversized-notification' })
        })
      })
    ])
    const diagnostic = tap.rows[2]?.body
    expect(
      diagnostic?.kind === 'status' ? diagnostic.providerFrame?.payload.byteLength : 0
    ).toBeGreaterThan(0)
    expect(JSON.stringify(diagnostic)).toContain('record-too-large')
  })

  it('admits suppressed diagnostics before settling a completed turn', () => {
    const tap = recorder()
    let rejectSuppression = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (...args) => {
      const body = args[1]
      if (body.kind === 'status' && body.text.includes('more provider notification')) {
        return rejectSuppression
          ? { accepted: false as const, reason: 'backpressure' as const }
          : (appendItem(...args), { accepted: true as const })
      }
      appendItem(...args)
      return { accepted: true as const }
    }
    const { translator } = translatorWith(tap)
    translator.handle(TURN_STARTED)
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN + 1; index += 1) {
      translator.handle(notification('future/notification', { value: index }))
    }
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'exec-order', command: 'run', status: 'inProgress' }
      })
    )
    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(tap.tombstones).toEqual([])
    rejectSuppression = false
    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
  })

  // A frame the classifier declines is intentionally unjournaled. #17720 turned that
  // into an admission failure, which the notification retry queue escalated to a
  // provider force-close, so no structured session could survive its first chrome frame.
  it('admits chrome and suppressed-benign frames without journaling them', () => {
    const { translator, tap } = translatorWith()
    translator.handle(TURN_STARTED)
    const before = tap.rows.length
    for (const method of [
      'remoteControl/status/changed',
      'thread/status/changed',
      'thread/tokenUsage/updated',
      'hook/started',
      'fs/changed',
      'rawResponse/completed',
      // Delta-shaped unknown methods reach the same early-out via the name heuristic.
      'future/somethingDelta'
    ]) {
      expect(translator.handle(notification(method, { status: 'disabled' }))).toEqual({
        accepted: true
      })
    }
    expect(tap.rows.length).toBe(before)
    expect(tap.publishes()).toBe(0)
  })

  it('bounds generic rows per turn while keeping the suppression visible and countable', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN + 20; index += 1) {
      translator.handle(notification('future/notification', { value: index }))
    }
    translator.handle(notification('item/future/outputDelta', { itemId: 'future', delta: 'x' }))
    window.fire()

    const generic = tap.rows.filter(
      (row) => row.body.kind === 'status' && row.body.providerFrame !== undefined
    )
    expect(generic).toHaveLength(MAX_CODEX_GENERIC_ROWS_PER_TURN)
    expect(generic[0]?.body).toMatchObject({
      kind: 'status',
      providerFrame: { kind: 'notification:future/notification' }
    })
    // The 20 capped frames reduce to ONE summary row whose count is exact, so
    // suppressed provider activity is never invisible.
    const summaries = new Map(
      tap.rows
        .filter((row) => row.key.includes('provider-frame-suppressed'))
        .map((row) => [row.key, row.body])
    )
    expect(summaries.size).toBe(1)
    expect([...summaries.values()][0]).toEqual({
      kind: 'status',
      text: '20 more provider notifications not shown for this turn'
    })
    expect(
      tap.rows.some(
        (row) =>
          row.body.kind === 'status' &&
          row.body.providerFrame?.kind === 'notification:item/future/outputDelta'
      )
    ).toBe(false)
  })

  it('coalesces a suppressed provider-frame flood into one append and publish', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN; index += 1) {
      translator.handle(notification('future/notification', { value: index }))
    }
    const publishesBeforeSuppression = tap.publishes()

    for (let index = 0; index < 500; index += 1) {
      translator.handle(notification('future/notification', { value: `suppressed-${index}` }))
    }

    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(0)
    expect(tap.publishes()).toBe(publishesBeforeSuppression)

    window.fire()

    const summaries = tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.body).toEqual({
      kind: 'status',
      text: '500 more provider notifications not shown for this turn'
    })
    expect(tap.publishes()).toBe(publishesBeforeSuppression + 1)
  })

  it('does not advance generic or suppression state when the sink rejects', () => {
    const { tap, window } = translatorWith()
    let reject = true
    const appendItem = tap.sink.appendItem
    tap.sink.tryAppendItem = (...args) => {
      if (reject) {
        return { accepted: false as const, reason: 'backpressure' as const }
      }
      appendItem(...args)
      return { accepted: true as const }
    }
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID,
      schedule: window.schedule
    })
    translator.handle(TURN_STARTED)
    translator.handle(notification('future/notification', { value: 1 }))
    reject = false
    translator.handle(notification('future/notification', { value: 2 }))
    expect(
      tap.rows.filter((row) => row.body.kind === 'status' && row.body.providerFrame)
    ).toHaveLength(1)

    for (let index = 1; index < MAX_CODEX_GENERIC_ROWS_PER_TURN; index += 1) {
      translator.handle(notification('future/notification', { value: index + 2 }))
    }
    reject = true
    translator.handle(notification('future/notification', { value: 'suppressed' }))
    window.fire()
    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(0)
    reject = false
    window.fire()
    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(1)
  })

  // The cap bounds noise, never evidence. #17720 dropped this exemption (and pinned the
  // capped behavior in a test), so a noisy turn could silently swallow provider errors.
  it('exempts error-surface provider frames from the generic-row cap', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    for (let index = 0; index < MAX_CODEX_GENERIC_ROWS_PER_TURN + 3; index += 1) {
      translator.handle(notification('future/notification', { value: index }))
    }
    translator.handle(notification('future/failure', { error: 'provider exploded' }))
    window.fire()

    const generic = tap.rows.filter(
      (row) => row.body.kind === 'status' && row.body.providerFrame !== undefined
    )
    expect(generic).toHaveLength(MAX_CODEX_GENERIC_ROWS_PER_TURN + 1)
    expect(generic.at(-1)?.body).toMatchObject({
      providerFrame: { kind: 'notification:future/failure' }
    })
    // Only the 3 capped noise frames reduce to a summary; the error is not counted there.
    expect(tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))).toHaveLength(1)
    expect(tap.rows.find((row) => row.key.includes('provider-frame-suppressed'))?.body).toEqual({
      kind: 'status',
      text: '3 more provider notifications not shown for this turn'
    })
  })

  it('coalesces oldest unique turn buckets while preserving counts and completion', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    const uniqueTurns = MAX_CODEX_GENERIC_TURN_BUCKETS + 12
    for (let turn = 0; turn < uniqueTurns; turn += 1) {
      const turnId = `adversarial-${turn}`
      for (let row = 0; row < MAX_CODEX_GENERIC_ROWS_PER_TURN + 1; row += 1) {
        translator.handle(
          notification('future/notification', {
            turn: { id: turnId },
            value: `${turnId}-${row}`
          })
        )
      }
    }
    window.fire()

    const summaries = tap.rows.filter((row) => row.key.includes('provider-frame-suppressed'))
    expect(
      summaries.some(
        (row) => row.body.kind === 'status' && row.body.text.includes('across evicted turns')
      )
    ).toBe(true)
    expect(
      summaries.reduce((total, row) => {
        if (row.body.kind !== 'status') {
          return total
        }
        const match = row.body.text.match(/^(\d+) more provider notification/)
        return total + (match ? Number(match[1]) : 0)
      }, 0)
    ).toBe(uniqueTurns)

    expect(translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))).toEqual({
      accepted: true
    })
    expect(tap.tombstones).toContain('legacy:codex:session-1:turn-lifecycle%3Aturn-1')
    // The two maps share one bounded bucket budget; this assertion documents
    // the contract for future changes even though the maps are private.
    expect(MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES).toBeGreaterThanOrEqual(
      MAX_CODEX_GENERIC_TURN_BUCKETS
    )
  })

  it('keeps a fresh session timeline empty through startup and status notifications', () => {
    const { translator, tap } = translatorWith()

    translator.handle(notification('thread/started', { thread: { id: THREAD_ID } }))
    for (let index = 0; index < 8; index += 1) {
      translator.handle(
        notification('mcpServer/startupStatus/updated', {
          server: `server-${index}`,
          status: 'starting'
        })
      )
    }
    translator.handle(notification('remoteControl/status/changed', { status: 'disabled' }))

    const timeline = projectStructuredItemsToNativeChat(
      tap.rows.map((row, index) => ({
        itemId: row.key,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body: row.body
      }))
    )
    expect(timeline).toEqual([])
  })

  it('projects only user and assistant content for a complete turn with hooks', () => {
    const { translator, tap } = translatorWith()

    translator.handle(notification('thread/started', { thread: { id: THREAD_ID } }))
    translator.handle(notification('hook/started', { run: { id: 'hook-1', status: 'running' } }))
    translator.handle(notification('account/rateLimits/updated', { rateLimits: { primary: null } }))
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        item: { type: 'userMessage', id: 'item-0', text: 'hi' }
      })
    )
    translator.handle(
      notification('hook/completed', { run: { id: 'hook-1', status: 'completed' } })
    )
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'hello' }
      })
    )
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    const timeline = projectStructuredItemsToNativeChat(
      tap.rows.map((row, index) => ({
        itemId: row.key,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body: row.body
      }))
    )
    expect(timeline.map(({ role, blocks }) => ({ role, blocks }))).toEqual([
      { role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] }
    ])
  })

  it('renders a system error carried by a suppressed status kind', () => {
    const { translator, tap } = translatorWith()

    translator.handle(
      notification('thread/status/changed', {
        threadId: THREAD_ID,
        status: { type: 'systemError' }
      })
    )

    const timeline = projectStructuredItemsToNativeChat(
      tap.rows.map((row, index) => ({
        itemId: row.key,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body: row.body
      }))
    )
    expect(timeline).toEqual([
      expect.objectContaining({
        role: 'system',
        blocks: [
          expect.objectContaining({
            providerFrame: expect.objectContaining({
              kind: 'notification:thread/status/changed'
            })
          })
        ]
      })
    ])
  })

  it('writes nothing more after dispose', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'gone' }))
    translator.dispose()
    window.fire()

    expect(tap.rows).toEqual([])
  })
})
