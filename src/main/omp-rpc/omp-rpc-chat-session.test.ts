import { describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcClientEvent,
  OmpRpcHistoryResult,
  OmpRpcSessionState,
  OmpRpcSlashCommand,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import type { OmpRpcSubagentSubscriptionLevel } from '../../shared/omp-rpc-subagent-protocol'
import {
  OMP_RPC_CHAT_SUBAGENT_SUBSCRIPTION_LEVEL,
  OmpRpcChatSession,
  type OmpRpcChatSessionIdentityReadback
} from './omp-rpc-chat-session'
import type { OmpRpcOwnedSession } from './omp-rpc-session-owner'

/** Minimal stand-in for the owned client: only the catalog surface this suite
 *  exercises is real, so the priming/replay contract is testable without a
 *  spawned child. */
function makeOwnedSession(options: {
  commands?: OmpRpcSlashCommand[]
  getCommandsRejects?: boolean
  history?: OmpRpcHistoryResult
  fetchHistoryRejects?: boolean
  setSubagentSubscriptionRejects?: boolean
  /** Reported by `get_state` — the only trace a session-changing slash command
   *  leaves (XLR-018). */
  state?: OmpRpcSessionState
  getStateRejects?: boolean
}) {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  const getCommands = vi.fn(async () => {
    if (options.getCommandsRejects) {
      throw new Error('transport closed')
    }
    const commands = options.commands ?? []
    for (const listener of listeners) {
      listener({ kind: 'commands', commands })
    }
    return commands
  })
  const fetchHistory = vi.fn(async () => {
    if (options.fetchHistoryRejects) {
      throw new Error('history drain overran totalMessages')
    }
    return options.history ?? { kind: 'complete' as const, messages: [], totalMessages: 0 }
  })
  const setSubagentSubscription = vi.fn(async (level: OmpRpcSubagentSubscriptionLevel) => {
    if (options.setSubagentSubscriptionRejects) {
      throw new Error('subagent event bus is unavailable')
    }
    return level
  })
  const prompt = vi.fn(async () => ({ agentInvoked: true }))
  const getState = vi.fn(async () => {
    if (options.getStateRejects) {
      throw new Error('transport closed')
    }
    return (
      options.state ?? {
        sessionFile: '/sessions/a.jsonl',
        sessionId: 'session-a',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }
    )
  })
  const client = {
    getCommands,
    fetchHistory,
    setSubagentSubscription,
    prompt,
    getState,
    on: (listener: (event: OmpRpcClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: vi.fn()
  } as unknown as OmpSessionOwningRpcClient
  return {
    owned: { client, owner: {} } as unknown as OmpRpcOwnedSession,
    getCommands,
    fetchHistory,
    setSubagentSubscription,
    prompt,
    getState,
    emit: (event: OmpRpcClientEvent) => {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

describe('OmpRpcChatSession command catalog', () => {
  it('fetches the catalog on construction, since the startup push predates this listener', async () => {
    // OMP emits its first available_commands_update during child bootstrap
    // (rpc-mode.ts), before this session attaches — so the catalog has to be
    // asked for, or the renderer never learns which commands RPC can run.
    const { owned, getCommands } = makeOwnedSession({ commands: [{ name: 'help' }] })
    const session = new OmpRpcChatSession(owned)
    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    await vi.waitFor(() => expect(getCommands).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(events).toEqual([{ kind: 'commands', commands: [{ name: 'help' }] }])
    )
    session.dispose()
  })

  it('replays the last catalog to a listener that subscribed after it arrived', async () => {
    const { owned } = makeOwnedSession({ commands: [{ name: 'model' }] })
    const session = new OmpRpcChatSession(owned)
    await vi.waitFor(() => expect(session.latestCommandsEvent).not.toBeNull())

    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    expect(events).toEqual([{ kind: 'commands', commands: [{ name: 'model' }] }])
    session.dispose()
  })

  it('replays only the newest catalog when OMP republishes it', async () => {
    const { owned, emit } = makeOwnedSession({ commands: [{ name: 'help' }] })
    const session = new OmpRpcChatSession(owned)
    await vi.waitFor(() => expect(session.latestCommandsEvent).not.toBeNull())
    emit({ kind: 'commands', commands: [{ name: 'help' }, { name: 'plugin:new' }] })

    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    expect(events).toEqual([
      { kind: 'commands', commands: [{ name: 'help' }, { name: 'plugin:new' }] }
    ])
    session.dispose()
  })

  it('stays usable when the catalog fetch fails', async () => {
    const { owned, getCommands } = makeOwnedSession({ getCommandsRejects: true })
    const session = new OmpRpcChatSession(owned)

    await vi.waitFor(() => expect(getCommands).toHaveBeenCalledTimes(1))
    expect(session.latestCommandsEvent).toBeNull()
    session.dispose()
  })
})

describe('OmpRpcChatSession history hydration', () => {
  it('decodes the drained history into rpc-sourced chat messages', async () => {
    const { owned, fetchHistory } = makeOwnedSession({
      history: {
        kind: 'complete',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1_700_000_000_000 }
        ],
        totalMessages: 1
      }
    })
    const session = new OmpRpcChatSession(owned)

    await expect(session.fetchHistory({ limit: 50 })).resolves.toEqual({
      ok: true,
      totalMessages: 1,
      messages: [
        {
          id: 'omp-rpc-history-0',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          timestamp: 1_700_000_000_000,
          originTimestamp: 1_700_000_000_000,
          source: 'rpc'
        }
      ]
    })
    expect(fetchHistory).toHaveBeenCalledWith({ limit: 50 })
    session.dispose()
  })

  it('reports session-busy as its own outcome so the caller can retry once idle', async () => {
    // Upstream refuses to start a paging walk while streaming or compacting
    // (rpc-mode.ts get_messages_page). That is a wire outcome, not a failure.
    const { owned } = makeOwnedSession({ history: { kind: 'session-busy' } })
    const session = new OmpRpcChatSession(owned)

    await expect(session.fetchHistory()).resolves.toEqual({ ok: false, reason: 'session-busy' })
    session.dispose()
  })

  it('fails closed rather than throwing when the drain cannot complete', async () => {
    const { owned } = makeOwnedSession({ fetchHistoryRejects: true })
    const session = new OmpRpcChatSession(owned)

    await expect(session.fetchHistory()).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    session.dispose()
  })
})

// XLR-018 (cross-lab review): the command route runs whatever OMP publishes,
// including extension commands whose handlers create, branch, or switch
// sessions. Upstream announces none of it (`handleRpcSessionChange` emits only
// `available_commands_update`), so an unread switch leaves main claiming — and
// excluding from every other pane — a session the child no longer writes.
describe('OmpRpcChatSession command session identity', () => {
  it('republishes the identity a command switched the child to', async () => {
    const harness = makeOwnedSession({
      state: {
        sessionFile: '/sessions/b.jsonl',
        sessionId: 'session-b',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }
    })
    const identities: OmpRpcChatSessionIdentityReadback[] = []
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl', (readback) =>
      identities.push(readback)
    )
    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    await expect(session.send({ message: '/branch', behavior: 'command' })).resolves.toEqual({
      ok: true,
      agentInvoked: true
    })

    expect(identities).toEqual([
      { kind: 'identity', sessionFilePath: '/sessions/b.jsonl', sessionId: 'session-b' }
    ])
    // Same channel a real `session_info_update` uses, so the renderer's
    // published-id precedence retires the stale on-disk guess unchanged.
    expect(events).toContainEqual({ kind: 'session-info', title: null, sessionId: 'session-b' })
    session.dispose()
  })

  it('reports nothing when the command left the session where it was', async () => {
    const harness = makeOwnedSession({})
    const identities: OmpRpcChatSessionIdentityReadback[] = []
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl', (readback) =>
      identities.push(readback)
    )
    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    await session.send({ message: '/help', behavior: 'command' })

    expect(harness.getState).toHaveBeenCalledTimes(1)
    expect(identities).toEqual([])
    expect(events.map((event) => event.kind)).not.toContain('session-info')
    session.dispose()
  })

  it('never reads the identity back for an ordinary chat send', async () => {
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl')

    await session.send({ message: 'hello', behavior: 'idle' })

    expect(harness.getState).not.toHaveBeenCalled()
    session.dispose()
  })

  // XLR-028: an unread identity is NOT evidence the child stayed put. The
  // command already ran, so main would keep claiming — and excluding from every
  // other pane — a session the child may have left, while a second pane is
  // handed the live one.
  it('fails the send closed and reports the identity unreadable when the read fails', async () => {
    const harness = makeOwnedSession({ getStateRejects: true })
    const identities: OmpRpcChatSessionIdentityReadback[] = []
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl', (readback) =>
      identities.push(readback)
    )

    const result = await session.send({ message: '/branch', behavior: 'command' })

    expect(result.ok).toBe(false)
    expect(identities).toEqual([{ kind: 'unreadable', reason: 'transport closed' }])
    session.dispose()
  })

  it('reports an identity-less read as unreadable too', async () => {
    const harness = makeOwnedSession({
      state: {
        sessionFile: '   ',
        sessionId: 'session-a',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }
    })
    const identities: OmpRpcChatSessionIdentityReadback[] = []
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl', (readback) =>
      identities.push(readback)
    )

    const result = await session.send({ message: '/branch', behavior: 'command' })

    expect(result.ok).toBe(false)
    expect(identities).toEqual([{ kind: 'unreadable', reason: 'child reported no session file' }])
    session.dispose()
  })

  // XLR-029: release must be able to join the read-back, or a handoff settles
  // and disposes between an authorized switch and its registry adoption.
  it('holds the identity-settled gate open until the read-back finishes', async () => {
    const gate = Promise.withResolvers<void>()
    const harness = makeOwnedSession({
      state: {
        sessionFile: '/sessions/b.jsonl',
        sessionId: 'session-b',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }
    })
    const adopted: string[] = []
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl', async () => {
      await gate.promise
      adopted.push('adopted')
    })

    const send = session.send({ message: '/branch', behavior: 'command' })
    let settled = false
    void session.whenSessionIdentitySettled().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    gate.resolve()
    await send
    await session.whenSessionIdentitySettled()
    expect(adopted).toEqual(['adopted'])
    session.dispose()
  })

  // The join has to be bounded: upstream answers `prompt` only once the skill
  // it dispatched finishes, and that request carries no response deadline — an
  // unbounded wait would leave the release (and every command surface it
  // excludes) pending forever.
  it('gives up on the identity gate rather than leaving a release pending forever', async () => {
    const harness = makeOwnedSession({
      state: {
        sessionFile: '/sessions/b.jsonl',
        sessionId: 'session-b',
        isStreaming: false,
        isCompacting: false,
        queuedMessageCount: 0
      }
    })
    const session = new OmpRpcChatSession(
      harness.owned,
      '/sessions/a.jsonl',
      () => new Promise<void>(() => {})
    )

    void session.send({ message: '/branch', behavior: 'command' })

    await expect(session.whenSessionIdentitySettled(1)).resolves.toBe(false)
    session.dispose()
  })

  // XLR-030: the owner tears this session down out from under its subscribers,
  // so the retirement has to travel over the fatal-frame channel the renderer's
  // ownership hook already reacts to.
  it('announces a retirement on the fatal-frame channel', () => {
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl')
    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))

    session.emitRetirement('agent_session_conflict')

    expect(events).toContainEqual({
      kind: 'protocol-fault',
      message: 'agent_session_conflict'
    })
    session.dispose()
  })

  // XLR-R5-001 (cross-lab review): the child can die between acquisition and
  // the renderer's asynchronous subscribe IPC. With nothing retained, that
  // subscriber never learns the transport is dead, so the pane stays
  // 'acquired' and keeps routing sends to a session main no longer has,
  // instead of asking its killed PTY back.
  it('replays a fatal exit that landed before the subscriber attached', () => {
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl')

    harness.emit({ kind: 'exit', code: 1, signal: null })

    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))
    expect(events).toContainEqual({ kind: 'exit', code: 1, signal: null })
    session.dispose()
  })

  it('replays a pre-subscription protocol fault, and only the first one', () => {
    // Terminal state, not a stream: the first fatal frame is the one that
    // proves the transport died, and a later one adds nothing.
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned, '/sessions/a.jsonl')

    harness.emit({ kind: 'protocol-fault', message: 'frame over limit' })
    harness.emit({ kind: 'exit', code: null, signal: 'SIGTERM' })

    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))
    expect(
      events.filter((event) => event.kind === 'exit' || event.kind === 'protocol-fault')
    ).toEqual([{ kind: 'protocol-fault', message: 'frame over limit' }])
    session.dispose()
  })
})

describe('OmpRpcChatSession subagent forwarding', () => {
  // Upstream defaults forwarding to "off": a pane that never sends
  // set_subagent_subscription sees no subagent frame at all (rpc.md
  // "Subagent subscriptions"), so the roster would silently stay empty.
  it('turns subagent forwarding on at construction', () => {
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned)
    expect(harness.setSubagentSubscription).toHaveBeenCalledWith(
      OMP_RPC_CHAT_SUBAGENT_SUBSCRIPTION_LEVEL
    )
    // `events` and not `progress`: the roster row renders the child's current
    // tool and newest output line, and only the event stream carries either.
    expect(OMP_RPC_CHAT_SUBAGENT_SUBSCRIPTION_LEVEL).toBe('events')
    session.dispose()
  })

  it('survives a refused subscription instead of failing the session', async () => {
    const harness = makeOwnedSession({ setSubagentSubscriptionRejects: true })
    const session = new OmpRpcChatSession(harness.owned)
    await Promise.resolve()
    expect(await session.fetchHistory()).toEqual({ ok: true, messages: [], totalMessages: 0 })
    session.dispose()
  })

  it('forwards subagent frames to subscribers', () => {
    const harness = makeOwnedSession({})
    const session = new OmpRpcChatSession(harness.owned)
    const events: OmpRpcClientEvent[] = []
    session.on((event) => events.push(event))
    harness.emit({
      kind: 'subagent-lifecycle',
      frame: {
        type: 'subagent_lifecycle',
        payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started' }
      }
    })
    // The catalog replays to every new subscriber, so assert containment.
    expect(events.map((event) => event.kind)).toContain('subagent-lifecycle')
    session.dispose()
  })
})
