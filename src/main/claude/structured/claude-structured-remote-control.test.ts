import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderRemoteControl } from '../../../shared/agent-session/remote-control/agent-session-provider-remote-control'
import type { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from './lifecycle/claude-structured-session-event'
import {
  USER_MESSAGE,
  adapterFor,
  claudeFrame,
  claudeWasSent,
  fakeClaude,
  identityFor,
  tick
} from './claude-structured-session-test-support'

type Answer = (enabled: boolean) => Promise<{ sessionUrl?: string }>
type Start = ReturnType<NonNullable<ClaudeStructuredSessionAdapterDeps['remoteControlStart']>>

const owned: { claude: ReturnType<typeof fakeClaude>; adapter: ClaudeStructuredSessionAdapter }[] =
  []

/** A chat whose initialize reply adds `fields`; records each `remote_control` request it receives. */
async function openChat({
  fields = {},
  start,
  answer = async (enabled) => (enabled ? { sessionUrl: 'https://claude.ai/code/session_1' } : {})
}: {
  fields?: Record<string, unknown>
  start?: Start
  answer?: Answer
}) {
  const requests: boolean[] = []
  const events: ClaudeStructuredSessionEvent[] = []
  const rows: unknown[] = []
  const claude = fakeClaude()
  const open = claude.openConnection
  // The shared fake has neither the Remote Control initialize fields nor the request.
  claude.openConnection = async (...args) => {
    const connection = await open(...args)
    const read = connection.initializationResult
    connection.initializationResult = () => read().then((reply) => Object.assign({}, reply, fields))
    connection.remoteControl = (enabled) => {
      requests.push(enabled)
      return answer(enabled)
    }
    return connection
  }
  const extraDeps = start ? { remoteControlStart: () => start } : {}
  const adapter = adapterFor(
    claude,
    {},
    events,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    extraDeps
  )
  owned.push({ claude, adapter })
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (...item) => void rows.push(item),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  await tick()
  const connection = claude.connections[0]
  if (!connection) {
    throw new Error('expected Claude connection')
  }
  /** What the host last heard for this chat's link; undefined when it heard nothing. */
  const reported = (): AgentSessionProviderRemoteControl | null | undefined =>
    events.findLast(
      (
        event
      ): event is Extract<ClaudeStructuredSessionEvent, { type: 'provider-remote-control' }> =>
        event.type === 'provider-remote-control'
    )?.remoteControl
  return { adapter, connection, requests, reported, rows }
}

afterEach(async () => {
  for (const { claude, adapter } of owned.splice(0)) {
    claude.dispose()
    await adapter.closeAll()
  }
})

describe('Claude chat Remote Control', () => {
  it("follows Claude Code's own setting and marks a link only an organization default turned on", async () => {
    const own = await openChat({ fields: { remote_control_auto_enable: true } })
    const orgDefault = await openChat({
      fields: { remote_control_auto_enable: true, remote_control_auto_on_by_default: true }
    })
    const unset = await openChat({})

    expect([own.requests, orgDefault.requests, unset.requests]).toEqual([[true], [true], []])
    expect(own.reported()).toEqual({
      state: 'connecting',
      sessionUrl: 'https://claude.ai/code/session_1'
    })
    expect(orgDefault.reported()).toEqual({
      state: 'connecting',
      sessionUrl: 'https://claude.ai/code/session_1',
      enabledByDefault: true
    })
  })

  it("lets the chat's saved choice outrank Orca's setting, and Orca's setting outrank Claude Code's", async () => {
    const chatOff = await openChat({
      fields: { remote_control_auto_enable: true },
      start: { choice: 'off', setting: 'on' }
    })
    const orcaOn = await openChat({ start: { choice: undefined, setting: 'on' } })
    const orcaOff = await openChat({
      fields: { remote_control_auto_enable: true },
      start: { choice: undefined, setting: 'off' }
    })
    const chatOn = await openChat({ start: { choice: 'on', setting: 'off' } })

    expect([chatOff.requests, orcaOn.requests, orcaOff.requests, chatOn.requests]).toEqual([
      [],
      [true],
      [],
      [true]
    ])
  })

  it('reports the refusal and keeps the chat working when Claude refuses Remote Control', async () => {
    const { adapter, connection, reported } = await openChat({
      start: { choice: 'on', setting: 'claude-code' },
      answer: () => Promise.reject(new Error('Remote Control requires claude.ai subscription auth'))
    })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(reported()).toEqual({
      state: 'failed',
      detail: 'Remote Control requires claude.ai subscription auth'
    })
    expect(claudeWasSent(connection, 'ship it')).toBe(true)
  })

  it('keeps the chat working while Remote Control has not answered', async () => {
    const pending = Promise.withResolvers<{ sessionUrl?: string }>()
    const { adapter, connection, requests } = await openChat({
      start: { choice: 'on', setting: 'claude-code' },
      answer: () => pending.promise
    })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(requests).toEqual([true])
    expect(claudeWasSent(connection, 'ship it')).toBe(true)
    pending.resolve({})
  })

  it("follows Claude's bridge frames without writing them into the transcript", async () => {
    const { connection, reported, rows } = await openChat({
      start: { choice: 'on', setting: 'claude-code' }
    })
    const before = rows.length

    claudeFrame(connection, {
      type: 'system',
      subtype: 'bridge_state',
      state: 'connected',
      uuid: 'bridge-1'
    })
    await tick()
    expect(reported()).toEqual({
      state: 'connected',
      sessionUrl: 'https://claude.ai/code/session_1'
    })

    claudeFrame(connection, {
      type: 'system',
      subtype: 'bridge_state',
      state: 'failed',
      detail: 'network unreachable',
      uuid: 'bridge-2'
    })
    await tick()
    expect(reported()).toEqual({
      state: 'failed',
      sessionUrl: 'https://claude.ai/code/session_1',
      detail: 'network unreachable'
    })
    expect(rows.length).toBe(before)
  })

  it("writes the person's prompt from Claude's apps as their own row, and nothing for Orca's echoes or Claude's injected turns", async () => {
    const { adapter, connection, rows } = await openChat({})
    const userRows = () =>
      rows.flatMap((row) => {
        const [identity, body] = row as [{ uuid?: string }, { kind?: string; role?: string }]
        return body.kind === 'message' && body.role === 'user' ? [{ identity, body }] : []
      })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })
    claudeFrame(connection, {
      type: 'user',
      uuid: 'task-note',
      parent_tool_use_id: null,
      isReplay: true,
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: 'background task finished' }
    })
    claudeFrame(connection, {
      type: 'user',
      uuid: 'phone-prompt',
      parent_tool_use_id: null,
      isReplay: true,
      origin: { kind: 'human' },
      message: { role: 'user', content: 'ship it' }
    })
    await tick()

    expect(userRows()).toEqual([
      {
        identity: expect.objectContaining({ uuid: 'phone-prompt' }),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'ship it' }],
          sentFrom: 'provider-remote-control'
        }
      }
    ])
    // Same text as Orca's still-unechoed send: the phone prompt never settles that send.
    expect(claudeWasSent(connection, 'ship it')).toBe(true)
  })

  it('connects and disconnects a running chat when the person flips it', async () => {
    const { adapter, requests, reported } = await openChat({})

    expect(adapter.setProviderRemoteControl('session-1', true)).toBe(true)
    await tick()
    expect(reported()?.state).toBe('connecting')

    expect(adapter.setProviderRemoteControl('session-1', false)).toBe(true)
    await tick()
    expect(requests).toEqual([true, false])
    expect(reported()).toBeNull()
    expect(adapter.setProviderRemoteControl('session-unknown', true)).toBe(false)
  })

  it('keeps showing the link when Claude refuses to disconnect, so disconnecting again sends again', async () => {
    const { adapter, requests, reported } = await openChat({
      start: { choice: 'on', setting: 'claude-code' },
      answer: async (enabled) => {
        if (!enabled) {
          throw new Error('Remote Control did not answer')
        }
        return { sessionUrl: 'https://claude.ai/code/session_1' }
      }
    })

    expect(adapter.setProviderRemoteControl('session-1', false)).toBe(true)
    await tick()
    expect(reported()).toEqual({
      state: 'connecting',
      sessionUrl: 'https://claude.ai/code/session_1'
    })

    expect(adapter.setProviderRemoteControl('session-1', false)).toBe(true)
    await tick()
    expect(requests).toEqual([true, false, false])
  })

  it('keeps a link the bridge connected when the connect request then times out', async () => {
    const pending = Promise.withResolvers<{ sessionUrl?: string }>()
    const { connection, reported } = await openChat({
      start: { choice: 'on', setting: 'claude-code' },
      answer: () => pending.promise
    })

    claudeFrame(connection, {
      type: 'system',
      subtype: 'bridge_state',
      state: 'connected',
      uuid: 'bridge-1'
    })
    await tick()
    pending.reject(new Error('Claude did not answer remote_control within 10000ms'))
    await tick()

    expect(reported()).toEqual({ state: 'connected' })
  })
})
