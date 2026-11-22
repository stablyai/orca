import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude-structured-session-state'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../claude-structured-session-test-support'
import { CLAUDE_UNSTARTED_SEND_GRACE_MS } from './claude-unstarted-send-watch'

type Settlement = Parameters<
  NonNullable<ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']>
>[0]

afterEach(() => {
  vi.useRealTimers()
})

async function idleChat(cancelConfirms: boolean) {
  const settlements: Settlement[] = []
  let connection!: FakeConnection
  const claude = fakeClaude({
    replayUuid: null,
    routes: {
      // As captured from 2.1.280: Claude reports the withdrawn send cancelled before it answers.
      cancel_async_message: (params) => {
        if (cancelConfirms) {
          lifecycle(connection, String(params?.uuid), 'cancelled')
        }
        return cancelConfirms
      }
    }
  })
  const adapter = await acquired(claude, {}, [], (settlement) => settlements.push(settlement))
  connection = claude.connections[0]!
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  state(connection, 'idle')
  return { adapter, connection, settlements }
}

function state(connection: FakeConnection, value: string): void {
  claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: value })
}

function lifecycle(connection: FakeConnection, uuid: string, value: string): void {
  claudeFrame(connection, { type: 'command_lifecycle', command_uuid: uuid, state: value })
}

async function send(
  adapter: ClaudeStructuredSessionAdapter,
  connection: FakeConnection,
  clientMessageId: string,
  text = 'check your mail'
): Promise<string> {
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: 7
  })
  const uuid = String(connection.sent.at(-1)!.uuid)
  lifecycle(connection, uuid, 'queued')
  return uuid
}

const withdrawals = (connection: FakeConnection) =>
  connection.calls.filter((call) => call.subtype === 'cancel_async_message')

it('withdraws a send Claude queued but never started after going idle, so later sends go through', async () => {
  const { adapter, connection, settlements } = await idleChat(true)
  const stalled = await send(adapter, connection, 'mail-1')
  await vi.advanceTimersByTimeAsync(CLAUDE_UNSTARTED_SEND_GRACE_MS)

  expect(withdrawals(connection)).toEqual([
    { subtype: 'cancel_async_message', params: { uuid: stalled } }
  ])
  expect(settlements).toEqual([
    expect.objectContaining({ clientMessageId: 'mail-1', state: 'rejected', unrun: true })
  ])
  expect(adapter.heldSends('session-1')).toEqual(new Set())

  const next = await send(adapter, connection, 'mail-2', 'next mail')
  state(connection, 'running')
  lifecycle(connection, next, 'started')
  claudeFrame(connection, {
    type: 'user',
    uuid: next,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'next mail' }] }
  })
  expect(settlements.at(-1)).toEqual({
    sessionId: 'session-1',
    clientMessageId: 'mail-2',
    providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: next }
  })
  expect(adapter.heldSends('session-1')).toEqual(new Set())
})

it('withdraws nothing when the queued send starts within the grace', async () => {
  const { adapter, connection, settlements } = await idleChat(true)
  const uuid = await send(adapter, connection, 'mail-1')
  state(connection, 'running')
  lifecycle(connection, uuid, 'started')
  await vi.advanceTimersByTimeAsync(CLAUDE_UNSTARTED_SEND_GRACE_MS * 2)

  expect(withdrawals(connection)).toEqual([])
  expect(settlements).toEqual([])
  expect(adapter.heldSends('session-1')).toEqual(new Set(['mail-1']))
})

it('releases a resent send that stalls again instead of resending it a second time', async () => {
  const { adapter, connection, settlements } = await idleChat(true)
  await send(adapter, connection, 'mail-1')
  await vi.advanceTimersByTimeAsync(CLAUDE_UNSTARTED_SEND_GRACE_MS)
  await send(adapter, connection, 'mail-1-again')
  await vi.advanceTimersByTimeAsync(CLAUDE_UNSTARTED_SEND_GRACE_MS)

  expect(withdrawals(connection)).toHaveLength(1)
  expect(settlements.at(-1)).toEqual({
    sessionId: 'session-1',
    clientMessageId: 'mail-1-again',
    state: 'unknown',
    reason: 'provider_idle_before_acknowledgement'
  })
  expect(adapter.heldSends('session-1')).toEqual(new Set())
})

it('releases the send as in doubt when Claude does not confirm the withdrawal', async () => {
  const { adapter, connection, settlements } = await idleChat(false)
  await send(adapter, connection, 'mail-1')
  await vi.advanceTimersByTimeAsync(CLAUDE_UNSTARTED_SEND_GRACE_MS)

  expect(settlements).toEqual([
    {
      sessionId: 'session-1',
      clientMessageId: 'mail-1',
      state: 'unknown',
      reason: 'provider_idle_before_acknowledgement'
    }
  ])
  expect(adapter.heldSends('session-1')).toEqual(new Set())
})
