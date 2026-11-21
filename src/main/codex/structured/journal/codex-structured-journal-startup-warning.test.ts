import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const CHILD_THREAD_ID = 'thread-child'
const OTHER_SESSION_ID = 'session-2'
const OTHER_THREAD_ID = 'thread-other'
const TURN_ID = 'turn-1'
const TEXT = '[features].multi_agent is deprecated'
const OTHER_TEXT = 'sandbox mode is unset'

type Row = { key: string; body: AgentJournalItemBody }

function recorder(refuseStatuses = 0) {
  const rows: Row[] = []
  let remainingRefusals = refuseStatuses
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    tryAppendItem: (identity: AgentJournalItemIdentity, body) => {
      if (body.kind === 'status' && remainingRefusals > 0) {
        remainingRefusals -= 1
        return { accepted: false, reason: 'backpressure' }
      }
      rows.push({ key: agentJournalItemKey(identity), body })
      return { accepted: true }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return { sink, rows }
}

function notification(
  method: string,
  params: unknown,
  threadId = THREAD_ID,
  sessionId = SESSION_ID
): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId, threadId, method, params }
}

function translator(tap: ReturnType<typeof recorder>, threadId = THREAD_ID) {
  return createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: threadId === OTHER_THREAD_ID ? OTHER_SESSION_ID : SESSION_ID,
    primaryThreadId: () => threadId
  })
}

function warningTexts(rows: readonly Row[]): string[] {
  return rows.flatMap((row) =>
    row.body.kind === 'status' && row.body.tone === 'warning' ? [row.body.text] : []
  )
}

describe('Codex startup warnings', () => {
  it('shows one card when a startup configWarning and warning share displayed text', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    codex.handle(notification('warning', { message: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT])
  })

  it('shows one card when the thread warning arrives before the connection warning', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('warning', { message: TEXT }))
    codex.handle(notification('configWarning', { summary: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT])
  })

  it('shows one card when the configWarning summary has surrounding whitespace', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: `${TEXT}\n` }))
    codex.handle(notification('warning', { message: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([`${TEXT}\n`])
  })

  it('keeps a startup warning that arrives alone', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('warning', { message: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT])
  })

  it('keeps a startup configWarning that arrives alone', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT])
  })

  it('keeps both startup cards when the displayed texts differ', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    codex.handle(notification('warning', { message: OTHER_TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT, OTHER_TEXT])
  })

  it('keeps a later turn warning that repeats the startup text', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    codex.handle(notification('warning', { message: TEXT }))
    codex.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    codex.handle(
      notification('turn/completed', {
        turn: { id: TURN_ID, status: 'completed', durationMs: 10 }
      })
    )
    codex.handle(notification('warning', { message: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT, TEXT])
  })

  it('keeps a warning that repeats the startup text during an active turn', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    codex.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    codex.handle(notification('warning', { message: TEXT }))
    expect(warningTexts(tap.rows)).toEqual([TEXT, TEXT])
  })

  it('keeps the same warning text on another chat', () => {
    const first = recorder()
    const second = recorder()
    const parent = translator(first)
    const other = translator(second, OTHER_THREAD_ID)
    parent.handle(notification('configWarning', { summary: TEXT }))
    parent.handle(notification('warning', { message: TEXT }))
    other.handle(
      notification('configWarning', { summary: TEXT }, OTHER_THREAD_ID, OTHER_SESSION_ID)
    )
    other.handle(notification('warning', { message: TEXT }, OTHER_THREAD_ID, OTHER_SESSION_ID))
    expect(warningTexts(first.rows)).toEqual([TEXT])
    expect(warningTexts(second.rows)).toEqual([TEXT])
  })

  it('keeps a child thread startup warning that repeats the parent text', () => {
    const tap = recorder()
    const codex = translator(tap)
    codex.handle(notification('configWarning', { summary: TEXT }))
    codex.handle(notification('warning', { message: TEXT }))
    codex.handle(notification('warning', { message: TEXT }, CHILD_THREAD_ID))
    expect(warningTexts(tap.rows)).toEqual([TEXT, TEXT])
  })

  it('does not drop the second warning when the first write is refused', () => {
    const tap = recorder(1)
    const codex = translator(tap)
    expect(codex.handle(notification('configWarning', { summary: TEXT }))).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(warningTexts(tap.rows)).toEqual([])
    expect(codex.handle(notification('warning', { message: TEXT }))).toEqual({ accepted: true })
    expect(codex.handle(notification('configWarning', { summary: TEXT }))).toEqual({
      accepted: true
    })
    expect(warningTexts(tap.rows)).toEqual([TEXT])
  })
})
