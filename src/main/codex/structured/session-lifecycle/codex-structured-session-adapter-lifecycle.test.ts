import {
  acquireReadyCodexForTest,
  THREAD_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { withMissingProviderExecutable } from '../../../provider-process/provider-executable-missing'
import type { CodexStructuredSessionEvent } from './codex-structured-session-state'

describe('CodexStructuredSessionAdapter lifecycle', () => {
  it('retains ownership until a child exit is proven and reports it once', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const interrupted: ReturnType<typeof readAgentJournalTurn>[] = []
    const adapter = adapterFor(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: {
        appendItem: (_identity, body) => {
          const turn = readAgentJournalTurn(body)
          if (turn?.state === 'interrupted') {
            interrupted.push(turn)
          }
        },
        appendTombstone: () => {},
        publish: () => {}
      }
    })

    const connection = codex.connections[0]
    connection.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1' }
    })
    const proveExit = connection.close
    connection.close = async () => {
      connection.closeCount += 1
      return false
    }
    connection.handlers.onExit?.(new Error('codex app-server connection ended'))

    expect(events.at(-1)).toEqual({
      type: 'ended',
      sessionId: 'session-1',
      reason: 'codex app-server connection ended',
      failure: { kind: 'providerExited' },
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: 'generation-1',
      observedAt: expect.any(Number)
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live codex app-server')
    expect(adapter.backgroundTaskStops('session-1')).toBeDefined()
    await expect(adapter.closeSession('session-1')).resolves.toBe(false)
    connection.close = proveExit
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(interrupted).toMatchObject([{ turnId: 'turn-1', state: 'interrupted' }])
    expect(interrupted[0]).not.toHaveProperty('outcome')
  })

  it('says the CLI was not found when the supervisor could not spawn it during acquisition', async () => {
    const codex = fakeCodex({
      'thread/start': () => {
        const spawnFailure = withMissingProviderExecutable(
          new Error('codex app-server connection ended (code 127): spawn codex ENOENT')
        )
        codex.connections[0]?.handlers.onExit?.(spawnFailure)
        throw spawnFailure
      }
    })
    const emitted: CodexStructuredSessionEvent[] = []
    const adapter = adapterFor(codex, {}, emitted)

    await expect(
      acquireReadyCodexForTest(adapter, {
        identity: identityFor('session-1'),
        fence: 7,
        spawnToken: 'spawn-9'
      })
    ).rejects.toThrow('spawn codex ENOENT')

    expect(emitted.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', failure: { kind: 'cliMissing' } }
    ])
  })

  it('reports an explicit forced close as a host fault', async () => {
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(fakeCodex(), {}, events)

    await expect(adapter.forceCloseSession('session-1')).resolves.toBe(true)

    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', failure: { kind: 'hostFault' } }
    ])
  })

  it('flushes the final coalesced text before a graceful close', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const bodies: AgentJournalMessageItem[] = []
    const lifecycles: unknown[] = []
    const tombstones: unknown[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => {
        if (body.kind === 'message') {
          bodies.push(body)
        } else if (readAgentJournalTurn(body)) {
          lifecycles.push({ identity, turnLifecycle: readAgentJournalTurn(body) })
        }
      },
      appendTombstone: (identity) => {
        tombstones.push(identity)
      },
      publish: () => {}
    }
    const adapter = adapterFor(codex, {}, events)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const notify = codex.connections[0]!.handlers.onNotification
    notify?.('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-1' } })
    notify?.('item/started', {
      threadId: THREAD_ID,
      item: { type: 'agentMessage', id: 'item-1', text: '' }
    })
    notify?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      itemId: 'item-1',
      delta: 'last words'
    })

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)

    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'requested-close' }
    ])
    expect(bodies.at(-1)?.blocks).toEqual([{ type: 'text', text: 'last words' }])
    expect(tombstones).toEqual([])
    expect(lifecycles.at(-1)).toEqual({
      identity: {
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:turn-1'
      },
      turnLifecycle: {
        turnId: 'turn-1',
        state: 'interrupted',
        userItemId: `codex:${THREAD_ID}:turn-1:0`,
        startedAt: expect.any(Number),
        completedAt: expect.any(Number)
      }
    })
  })
})
