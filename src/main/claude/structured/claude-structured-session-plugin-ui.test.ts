import { describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  tick,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import { claudeFocusedPlugin } from '../claude-plugin-ui'

// Claude Code 2.1.303 recorded shape; UUID and session ID are test identities.
const FOCUSED_PANE = {
  type: 'system',
  subtype: 'ui_panes',
  panes: [{ id: 'blast-radius', title: 'Blast Radius', plugin: 'blast-radius', rows: 10 }],
  shown_id: 'blast-radius',
  focused_id: null,
  focus_requested_id: 'blast-radius',
  uuid: '00000000-0000-4000-8000-000000000795'
}

async function setup() {
  const claude = fakeClaude()
  const events: ClaudeStructuredSessionEvent[] = []
  const persisted: unknown[] = []
  const items: AgentJournalItemBody[] = []
  const sink = {
    ...recordingJournalSink(),
    appendItem: (_identity: unknown, body: AgentJournalItemBody) => {
      items.push(body)
    },
    observeExit: vi.fn()
  }
  const adapter = adapterFor(claude, {}, events, persisted)
  const acquire = (fence = 7) =>
    adapter.acquire({
      identity: identityFor(),
      fence,
      spawnToken: `spawn-${fence}`,
      events: sink
    })
  const dispatch = (id = 'client-1', fence = 7) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      body: USER_MESSAGE,
      fence
    })
  await acquire()
  return { claude, events, persisted, sink, items, adapter, acquire, dispatch }
}

describe('focused Claude plugin pane recovery', () => {
  it.each([null, 'child-tool'])(
    'closes the held child once without interrupt for parent %s',
    async (parent) => {
      const state = await setup()
      const first = state.claude.connections[0]
      await state.dispatch()
      claudeFrame(first, { ...FOCUSED_PANE, parent_tool_use_id: parent })
      claudeFrame(first, FOCUSED_PANE)
      await vi.waitFor(() =>
        expect(state.events.filter((event) => event.type === 'ended')).toHaveLength(1)
      )
      expect(first.closeCount).toBe(1)
      expect(first.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
      expect(state.events.find((event) => event.type === 'ended')).toMatchObject({
        failure: {
          kind: 'pluginInputRequired',
          detail: { text: 'blast-radius', audience: 'person' }
        },
        reason:
          'Claude stopped because the "blast-radius" plugin is waiting for input in a terminal pane. Disable the plugin for chat sessions, or run the task in a Claude terminal.'
      })
      expect(state.sink.observeExit).toHaveBeenCalledOnce()
      expect(state.persisted).toHaveLength(1)
      expect(state.items.flatMap((body) => readAgentJournalTurn(body) ?? []).at(-1)).toMatchObject({
        state: 'interrupted',
        outcome: 'failure'
      })
      await state.adapter.closeAll()
    }
  )

  it('keeps passive panes running and ignores foreign, idle and settled focus frames', async () => {
    const state = await setup()
    const first = state.claude.connections[0]
    claudeFrame(first, FOCUSED_PANE)
    await state.dispatch()
    claudeFrame(first, { ...FOCUSED_PANE, focus_requested_id: null })
    claudeFrame(first, { type: 'system', subtype: 'ui_invalidate' })
    claudeFrame(first, { type: 'system', subtype: 'ui_status', text: null })
    claudeFrame(first, { ...FOCUSED_PANE, session_id: 'foreign-session' })
    await tick()
    expect(first.closeCount).toBe(0)
    claudeFrame(first, { type: 'result', subtype: 'success', is_error: false, result: 'OK' })
    claudeFrame(first, FOCUSED_PANE)
    await tick()
    expect(first.closeCount).toBe(0)
    expect(state.events.some((event) => event.type === 'ended')).toBe(false)
    await state.adapter.closeAll()
  })

  it('waits for close then sends on a fresh connection, ignoring late frames from the old child', async () => {
    const state = await setup()
    const first = state.claude.connections[0]
    const closed = Promise.withResolvers<boolean>()
    const close = first.close
    first.close = async () => {
      await close()
      return closed.promise
    }
    await state.dispatch()
    claudeFrame(first, FOCUSED_PANE)
    const next = state.acquire(8)
    await tick()
    expect(state.claude.connections).toHaveLength(1)
    closed.resolve(true)
    await next
    await state.dispatch('client-next', 8)
    const second = state.claude.connections[1]
    claudeFrame(first, FOCUSED_PANE)
    expect(second.closeCount).toBe(0)
    claudeFrame(second, {
      type: 'assistant',
      uuid: 'fresh-reply',
      message: { role: 'assistant', content: [{ type: 'text', text: 'FOLLOW_UP_OK' }] }
    })
    claudeFrame(second, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'FOLLOW_UP_OK'
    })
    expect(first.sent.filter((message) => message.type === 'user')).toHaveLength(1)
    expect(second.sent.filter((message) => message.type === 'user')).toHaveLength(1)
    expect(state.events.filter((event) => event.type === 'ended')).toHaveLength(1)
    await state.adapter.closeAll()
  })

  it('uses the focused pane plugin name, falling back to its trimmed ID', () => {
    expect(claudeFocusedPlugin({ ...FOCUSED_PANE, focus_requested_id: ' blast-radius ' })).toBe(
      'blast-radius'
    )
    expect(
      claudeFocusedPlugin({ ...FOCUSED_PANE, panes: [], focus_requested_id: ' pane-2 ' })
    ).toBe('pane-2')
    expect(claudeFocusedPlugin({ ...FOCUSED_PANE, focus_requested_id: ' ' })).toBeNull()
  })
})
