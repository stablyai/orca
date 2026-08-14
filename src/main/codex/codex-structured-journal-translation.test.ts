import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD
} from './codex-structured-prompt-replies'
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
  let pending: (() => void) | null = null
  return {
    schedule: (run: () => void) => {
      pending = run
      return () => {
        pending = null
      }
    },
    fire: () => {
      const run = pending
      pending = null
      run?.()
    },
    idle: () => pending === null
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
  it('durably opens and closes the primary turn cancellation lifecycle', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.handle(TURN_STARTED)
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(tap.rows).toEqual([
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-1',
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: TURN_ID, state: 'running' }
        }
      }
    ])
    expect(tap.tombstones).toEqual(['legacy:codex:session-1:turn-lifecycle%3Aturn-1'])
  })

  it('journals a user turn and the assistant answer under durable codex keys', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        item: { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'hi' }] }
      })
    )
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'hello' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'codex:thread-abc:turn-1:1'
    ])
    expect(tap.rows[1]?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hello' }]
    })
  })

  it('folds streamed deltas into one snapshot row on the same key the item started under', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'he' }))
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'llo' }))
    window.fire()

    // `item/started` had no text to journal; only the coalesced snapshot lands.
    expect(tap.rows).toEqual([
      {
        key: 'codex:thread-abc:turn-1:0',
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] }
      }
    ])
  })

  it('upserts the streamed text and the completed body onto one row, body last', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'part' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'partial' }
      })
    )
    window.fire()

    // One key, so the reducer keeps the last write; the stale snapshot cannot
    // come back after the window it was pending on fires.
    expect(new Set(tap.rows.map((row) => row.key))).toEqual(new Set(['codex:thread-abc:turn-1:0']))
    expect(tap.rows.map((row) => row.body)).toEqual([
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'part' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] }
    ])
  })

  it('flushes pending text before a lifecycle event, so nothing is journaled ahead of it', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'text' }))
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'item-2', command: 'ls', status: 'inProgress' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'orca:codex-item%3Athread-abc%3Aitem-2'
    ])
  })

  it('flushes what streamed when the child dies unannounced', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )
    translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'half' }))
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'app-server exited' })

    expect(tap.rows.at(-1)?.body).toMatchObject({ blocks: [{ type: 'text', text: 'half' }] })
    expect(window.idle()).toBe(true)
  })

  it('journals an approval naming the command the item already announced, and binds it', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: {
          type: 'commandExecution',
          id: 'item-2',
          command: 'rm -rf build',
          status: 'inProgress'
        }
      })
    )
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept', 'decline'] },
      codexItemId: 'item-2',
      promptKey: 'item-2'
    })

    const approval = tap.rows.at(-1)
    expect(approval?.key).toBe('orca:codex-prompt%3Athread-abc%3Aitem-2')
    expect(approval?.body).toMatchObject({ kind: 'approval', detail: 'rm -rf build' })
    expect(tap.bound).toEqual([['orca:codex-prompt%3Athread-abc%3Aitem-2', THREAD_ID, 'item-2']])
  })

  it('journals one row per approval when a tool item asks twice', () => {
    const { translator, tap } = translatorWith()
    const ask = (promptKey: string): void => {
      translator.handle({
        type: 'prompt',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        method: CODEX_COMMAND_APPROVAL_METHOD,
        params: { availableDecisions: ['accept', 'decline'] },
        codexItemId: 'item-2',
        promptKey
      })
    }

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', {
        item: { type: 'commandExecution', id: 'item-2', command: 'ls', status: 'inProgress' }
      })
    )
    ask('approval-a')
    ask('approval-b')

    // Two asks, two answerable rows — keying by the tool item would have made the
    // second ask overwrite the first, leaving the turn blocked.
    const approvals = tap.rows.slice(-2)
    expect(approvals.map((row) => row.key)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Aapproval-a',
      'orca:codex-prompt%3Athread-abc%3Aapproval-b'
    ])
    // Both still name the command the shared item announced.
    expect(approvals.every((row) => (row.body as { detail?: string }).detail === 'ls')).toBe(true)
    expect(tap.bound.map(([, , promptKey]) => promptKey)).toEqual(['approval-a', 'approval-b'])
  })

  it('journals and binds one row per question in a user-input request', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle({
      type: 'prompt',
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      method: CODEX_USER_INPUT_METHOD,
      params: {
        questions: [
          { id: 'q1', question: 'Which branch?', options: [{ label: 'main' }] },
          { id: 'q2', question: 'Proceed?', options: [{ label: 'yes' }] }
        ]
      },
      codexItemId: 'item-3',
      promptKey: 'item-3'
    })

    expect(tap.rows.map((row) => row.key)).toEqual([
      'orca:codex-prompt%3Athread-abc%3Aitem-3%3Aq1',
      'orca:codex-prompt%3Athread-abc%3Aitem-3%3Aq2'
    ])
    expect(tap.bound.map(([, , promptKey]) => promptKey)).toEqual(['item-3', 'item-3'])
  })

  it('starts a new turn at ordinal zero and refuses to adopt an ended turn', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-0', text: 'one' } })
    )
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'orphan' }
      })
    )
    translator.handle(notification('turn/started', { turn: { id: 'turn-2' } }))
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-2', text: 'two' } })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'orca:codex-item%3Athread-abc%3Aitem-1',
      'codex:thread-abc:turn-2:0'
    ])
  })

  it('prefers a turn id the event carries over the turn currently open', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', {
        turnId: 'turn-9',
        item: { type: 'userMessage', id: 'item-0', text: 'late' }
      })
    )

    expect(tap.rows[0]?.key).toBe('codex:thread-abc:turn-9:0')
  })

  it('keeps interleaved thread turns, items, and deltas separate', () => {
    const { translator, tap } = translatorWith()
    const child = (method: string, params: unknown): CodexStructuredSessionEvent => ({
      type: 'notification',
      sessionId: SESSION_ID,
      threadId: 'thread-child',
      method,
      params
    })

    translator.handle(TURN_STARTED)
    translator.handle(child('turn/started', { threadId: 'thread-child', turnId: 'turn-child' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-0', text: 'root' }
      })
    )
    translator.handle(
      child('item/completed', { item: { type: 'agentMessage', id: 'item-0', text: 'child' } })
    )
    translator.handle(child('turn/completed', { turnId: 'turn-child' }))
    translator.handle(
      notification('item/completed', {
        item: { type: 'agentMessage', id: 'item-1', text: 'still root' }
      })
    )

    expect(tap.rows.map((row) => row.key)).toEqual([
      'codex:thread-abc:turn-1:0',
      'codex:thread-child:turn-child:0',
      'codex:thread-abc:turn-1:1'
    ])
  })

  it('checkpoints long streams geometrically and flushes the final snapshot', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    )

    for (let index = 0; index < 512; index += 1) {
      translator.handle(notification('item/agentMessage/delta', { itemId: 'item-1', delta: 'x' }))
      window.fire()
    }
    translator.flush()

    expect(tap.rows.length).toBeLessThan(40)
    expect(tap.rows.at(-1)?.body).toMatchObject({
      blocks: [{ type: 'text', text: 'x'.repeat(512) }]
    })
  })

  it('publishes after every write so a subscriber never trails the journal', () => {
    const { translator, tap } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(
      notification('item/completed', { item: { type: 'userMessage', id: 'item-0', text: 'hi' } })
    )

    expect(tap.publishes()).toBe(1)
  })

  it('journals malformed item events and deltas instead of hiding them', () => {
    const { translator, tap, window } = translatorWith()

    translator.handle(TURN_STARTED)
    translator.handle(notification('item/completed', {}))
    translator.handle(notification('item/agentMessage/delta', { delta: 'orphan' }))
    window.fire()

    expect(tap.rows.map((row) => row.body)).toEqual([
      expect.objectContaining({
        kind: 'status',
        providerFrame: expect.objectContaining({ kind: 'notification:item/completed' })
      }),
      expect.objectContaining({
        kind: 'status',
        providerFrame: expect.objectContaining({ kind: 'notification:item/agentMessage/delta' })
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
