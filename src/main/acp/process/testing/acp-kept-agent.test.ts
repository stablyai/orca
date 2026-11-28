import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderRelayChannel,
  ProviderRelaySink
} from '../../../provider-relay/provider-relay-channel'
import { RelayedProviderChild } from '../../../provider-relay/relayed-provider-child'
import { relayedManagedProcess } from '../../../provider-relay/relayed-managed-process'
import { createAcpAgentConnection } from '../acp-agent-connection'
import type { AcpSessionEvent } from '../../protocol/acp-session-events'
import { ANTIGRAVITY_ACP_DIALECT } from '../../acp-dialects/antigravity-dialect'
import { AcpStructuredLane } from '../../journal/acp-structured-lane'
import { AcpStructuredTurns } from '../../turns/acp-structured-turns'
import { AcpAgentError } from '../../transport/acp-errors'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { acpKeptAgent, restorableAcpSession } from '../acp-kept-agent'
import { AcpRelayTurns } from '../acp-relay-turns'
import { tick } from './acp-scripted-agent.test-support'

const policy = () => ({ idleStopMs: null, markers: [] })
const line = (message: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: '2.0', ...message })
const update = (sessionUpdate: string, rest: Record<string, unknown>): string =>
  line({
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate, ...rest } }
  })

/** A kept ACP agent as the daemon hands it back: what it kept, then its spool; `exits` ends it mid-attach. */
function keptAgent(
  exits: boolean,
  options?: {
    outstanding?: { id: number; method: string; replayedWhole?: boolean }[]
    maxClientRequestId?: number
  }
) {
  const closes = vi.fn(async () => ({}))
  let sink: ProviderRelaySink | null = null
  const writes: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relayed child calls only these channel members.
  const channel = {
    bind: (_relayId: string, bound: ProviderRelaySink) => {
      sink = bound
      return () => {}
    },
    attach: async () => {
      sink?.line('relayInitialize', 0, line({ id: 1, result: { protocolVersion: 1 } }))
      sink?.line('relayKept', 2, line({ id: 2, result: { sessionId: 's1', configOptions: [] } }))
      sink?.line('relayKept', 3, update('current_mode_update', { currentModeId: 'plan' }))
      sink?.line(
        'relayData',
        4,
        update('agent_message_chunk', { content: { type: 'text', text: 'last words' } })
      )
      if (exits) {
        sink?.exit({ code: 0, signal: null })
      }
      return {
        replayThroughSeq: 4,
        pending: [],
        ...(options?.outstanding ? { outstanding: options.outstanding } : {}),
        maxClientRequestId: options?.maxClientRequestId ?? 2,
        initializeResultSent: true,
        stderrTail: '',
        exit: exits ? { code: 0, signal: null } : null,
        kept: [
          { seq: 2, name: 'a:session/new' },
          { seq: 3, name: 'l:"sessionUpdate":"current_mode_update"' }
        ]
      }
    },
    write: async (_relayId: string, data: string) => {
      writes.push(data)
      return {}
    },
    ack: async () => ({}),
    scheduleAck: (run: () => void) => {
      const timer = setTimeout(run, 1_000)
      return () => clearTimeout(timer)
    },
    close: closes,
    detach: async () => ({})
  } as unknown as ProviderRelayChannel
  const child = new RelayedProviderChild({
    channel,
    relayId: 'r',
    pid: 42,
    policy,
    passWhileHeld: () => false
  })
  const deliver = (seq: number, payload: string) => sink?.line('relayData', seq, payload)
  return { child, writes, closes, deliver }
}

describe('kept ACP agent reattach', () => {
  it('never closes a kept agent while quit hands it to the daemon', async () => {
    const { child, closes } = keptAgent(false)
    await child.start(1)
    const managed = relayedManagedProcess(child)
    // Quit's own detach is still saving and acking when an abandoned start closes the agent.
    const detaching = child.detach(policy())
    await managed.close()
    await detaching
    expect(child.handedOff).toBe(true)
    expect(closes).not.toHaveBeenCalled()
  })

  it('hands a kept agent to the daemon on every close during quit, never closing it', async () => {
    const { child, closes } = keptAgent(false)
    await child.start(1)
    // As quit's own detach does: it takes the chat's agent once, so a second caller gets false.
    let taken = false
    const handOff = () => {
      const first = !taken
      taken = true
      return first ? child.detach(policy()).then(() => true) : Promise.resolve(false)
    }
    const managed = relayedManagedProcess(child, handOff)
    // Both the abandoned launch and the connection's own close arrive while the hand-off settles.
    await Promise.all([managed.close(), managed.close()])
    expect(child.handedOff).toBe(true)
    expect(closes).not.toHaveBeenCalled()
  })

  it('answers initialize and the session start from what was kept, never reaching the agent', async () => {
    const { child, writes } = keptAgent(false)
    await child.start(1)
    const connection = createAcpAgentConnection(
      { command: 'agent', args: [], cwd: '/tmp' },
      {
        relayed: {
          managed: relayedManagedProcess(child),
          child,
          reattached: true,
          turns: new AcpRelayTurns()
        }
      }
    )
    const events: AcpSessionEvent[] = []
    const kinds = () =>
      events.map((event) => event.kind === 'known' && event.notification.update.sessionUpdate)
    connection.subscribe((event) => events.push(event))
    await expect(connection.initialize()).resolves.toMatchObject({ protocolVersion: 1 })
    await expect(
      connection.start({ cwd: '/tmp', mcpServers: [], sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'load', sessionId: 's1' })
    // The mode changed after the start applies before anything new; the spool waits for release.
    expect(kinds()).toEqual(['current_mode_update'])
    connection.kept?.releaseOutput()
    await vi.waitFor(() => expect(kinds()).toEqual(['current_mode_update', 'agent_message_chunk']))
    // A later start returns the running session; nothing is sent to the agent.
    await expect(connection.start({ cwd: '/tmp', mcpServers: [] })).resolves.toMatchObject({
      sessionId: 's1'
    })
    expect(writes).toEqual([])
  })

  it('opens an agent that ended while Orca was closed, so its last output reaches the chat', async () => {
    const { child } = keptAgent(true)
    await child.start(1)
    expect(restorableAcpSession(acpKeptAgent(child), 's1')).toMatchObject({ sessionId: 's1' })
    const { child: live } = keptAgent(false)
    await live.start(1)
    expect(restorableAcpSession(acpKeptAgent(live), 's1')).toMatchObject({ sessionId: 's1' })
    // A kept agent running another session than the chat's can't carry it on either.
    expect(restorableAcpSession(acpKeptAgent(live), 's2')).toBeNull()
  })

  it('adopts all outstanding pre-restart prompts and holds new sends across out-of-order replies', async () => {
    const { child, writes, deliver } = keptAgent(false, {
      outstanding: [
        { id: 10, method: 'session/prompt', replayedWhole: false },
        { id: 11, method: 'session/prompt', replayedWhole: true }
      ],
      maxClientRequestId: 11
    })
    await child.start(1)
    const kept = acpKeptAgent(child)
    expect(kept.earlierPromptIds).toEqual([10, 11])
    expect(kept.earlierPromptId).toBe(11)
    expect(kept.earlierPromptWhole).toBe(false)

    const relayTurns = new AcpRelayTurns()
    const floor = relayTurns.ackFloor()
    const connection = createAcpAgentConnection(
      { command: 'agent', args: [], cwd: '/tmp' },
      {
        concurrentPrompts: true,
        relayed: {
          managed: relayedManagedProcess(child),
          child,
          reattached: true,
          turns: relayTurns
        }
      }
    )
    await connection.initialize()
    await connection.start({ cwd: '/tmp', mcpServers: [], sessionId: 's1' })
    const keptSession = connection.kept
    expect(keptSession).not.toBeNull()
    if (!keptSession) {
      return
    }

    let clock = 100
    let turns!: AcpStructuredTurns
    const lane = new AcpStructuredLane({
      sink: {
        tryAppendTransition: (transition) => {
          transition.onPublished?.()
          return { accepted: true }
        }
      },
      sessionId: 'sess-reattach',
      agent: 'antigravity',
      agentName: 'Antigravity',
      generation: 'gen-reattach',
      providerSessionId: 's1',
      dialect: ANTIGRAVITY_ACP_DIALECT,
      logger: createStructuredAgentSessionLogger(),
      now: () => ++clock,
      onInputAccepted: (clientMessageId) => turns.accept(clientMessageId),
      onFailed: (reason) => {
        throw new Error(`lane failed unexpectedly: ${reason}`)
      }
    })
    turns = new AcpStructuredTurns({
      connection,
      withdrawRequests: () => {},
      lane,
      agentName: 'Antigravity',
      dialect: ANTIGRAVITY_ACP_DIALECT,
      now: () => ++clock,
      settle: () => {},
      sessionLost: () => {}
    })

    try {
      turns.adoptEarlier('m-adopted', () => keptSession.earlierPrompt())
      keptSession.releaseOutput()
      expect(floor.promptId).toBe(10)

      turns.dispatch(
        {
          clientMessageId: 'm-next',
          prompt: [{ type: 'text', text: 'after both settle' }],
          requestedAt: 101
        },
        'mail'
      )

      // The second pre-restart prompt replies first (out of order): new sends must stay held.
      deliver(5, line({ id: 11, result: { stopReason: 'end_turn' } }))
      await tick()
      await tick()
      expect(writes).toEqual([])
      expect(turns.running).toBe(true)
      expect(floor.promptId).toBe(10)

      // Once the remaining pre-restart prompt replies, the waiting send dispatches cleanly.
      deliver(6, line({ id: 10, result: { stopReason: 'end_turn' } }))
      await vi.waitFor(() => expect(writes).toHaveLength(1))
      expect(JSON.parse(writes[0])).toMatchObject({
        id: 12,
        method: 'session/prompt',
        params: { sessionId: 's1', prompt: [{ type: 'text', text: 'after both settle' }] }
      })

      // Normal concurrent steering resumes after both pre-restart prompts have settled.
      turns.dispatch(
        {
          clientMessageId: 'm-steer',
          prompt: [{ type: 'text', text: 'concurrent follow-up' }],
          requestedAt: 102
        },
        'mail'
      )
      await vi.waitFor(() => expect(writes).toHaveLength(2))
      expect(JSON.parse(writes[1])).toMatchObject({
        id: 13,
        method: 'session/prompt',
        params: { sessionId: 's1', prompt: [{ type: 'text', text: 'concurrent follow-up' }] }
      })

      deliver(7, line({ id: 12, result: { stopReason: 'end_turn' } }))
      deliver(8, line({ id: 13, result: { stopReason: 'end_turn' } }))
      await vi.waitFor(() => expect(turns.running).toBe(false))
      await vi.waitFor(() => expect(floor.promptId).toBeNull())
    } finally {
      lane.dispose()
    }
  })

  it('surfaces a session-loss rejection from any adopted pre-restart prompt while keeping ordinary refusals non-fatal', async () => {
    const cases: {
      name: string
      reply10: Record<string, unknown>
      reply11: Record<string, unknown>
      expectLost: boolean
    }[] = [
      {
        name: 'earlier fulfills, later rejects with session loss',
        reply10: { id: 10, result: { stopReason: 'end_turn' } },
        reply11: {
          id: 11,
          error: { code: -32603, message: 'Internal error', data: 'Session not found: s1' }
        },
        expectLost: true
      },
      {
        name: 'earlier rejects with session loss, later rejects with ordinary refusal',
        reply10: {
          id: 10,
          error: { code: -32603, message: 'Internal error', data: 'Session not found: s1' }
        },
        reply11: { id: 11, error: { code: -32602, message: 'Invalid params' } },
        expectLost: true
      },
      {
        name: 'earlier fulfills, later rejects with ordinary steer refusal',
        reply10: { id: 10, result: { stopReason: 'end_turn' } },
        reply11: { id: 11, error: { code: -32602, message: 'Invalid params' } },
        expectLost: false
      }
    ]

    for (const tc of cases) {
      const { child, writes, deliver } = keptAgent(false, {
        outstanding: [
          { id: 10, method: 'session/prompt', replayedWhole: false },
          { id: 11, method: 'session/prompt', replayedWhole: false }
        ],
        maxClientRequestId: 11
      })
      await child.start(1)
      const relayTurns = new AcpRelayTurns()
      const connection = createAcpAgentConnection(
        { command: 'agent', args: [], cwd: '/tmp' },
        {
          concurrentPrompts: true,
          relayed: {
            managed: relayedManagedProcess(child),
            child,
            reattached: true,
            turns: relayTurns
          }
        }
      )
      await connection.initialize()
      await connection.start({ cwd: '/tmp', mcpServers: [], sessionId: 's1' })
      const keptSession = connection.kept
      expect(keptSession, tc.name).not.toBeNull()
      if (!keptSession) {
        return
      }

      let clock = 200
      const sessionLosses: Error[] = []
      let turns!: AcpStructuredTurns
      const lane = new AcpStructuredLane({
        sink: {
          tryAppendTransition: (transition) => {
            transition.onPublished?.()
            return { accepted: true }
          }
        },
        sessionId: 'sess-reattach-loss',
        agent: 'antigravity',
        agentName: 'Antigravity',
        generation: 'gen-loss',
        providerSessionId: 's1',
        dialect: ANTIGRAVITY_ACP_DIALECT,
        logger: createStructuredAgentSessionLogger(),
        now: () => ++clock,
        onInputAccepted: (clientMessageId) => turns.accept(clientMessageId),
        onFailed: (reason) => {
          throw new Error(`lane failed unexpectedly (${tc.name}): ${reason}`)
        }
      })
      turns = new AcpStructuredTurns({
        connection,
        withdrawRequests: () => {},
        lane,
        agentName: 'Antigravity',
        dialect: ANTIGRAVITY_ACP_DIALECT,
        now: () => ++clock,
        settle: () => {},
        sessionLost: (error) => sessionLosses.push(error)
      })

      try {
        const isSessionLost = (error: unknown): boolean =>
          error instanceof AcpAgentError && lane.translator.sessionLost(error)
        turns.adoptEarlier('m-adopted', () => keptSession.earlierPrompt(isSessionLost))
        keptSession.releaseOutput()
        turns.dispatch(
          {
            clientMessageId: 'm-next',
            prompt: [{ type: 'text', text: 'queued after reattach' }],
            requestedAt: 201
          },
          'mail'
        )

        deliver(5, line(tc.reply10))
        deliver(6, line(tc.reply11))

        if (tc.expectLost) {
          await vi.waitFor(() => expect(sessionLosses, tc.name).toHaveLength(1))
          expect(sessionLosses[0], tc.name).toBeInstanceOf(AcpAgentError)
          expect(writes, tc.name).toEqual([])
          expect(turns.running, tc.name).toBe(false)
        } else {
          await vi.waitFor(() => expect(writes, tc.name).toHaveLength(1))
          expect(sessionLosses, tc.name).toEqual([])
          deliver(7, line({ id: 12, result: { stopReason: 'end_turn' } }))
          await vi.waitFor(() => expect(turns.running, tc.name).toBe(false))
        }
      } finally {
        lane.dispose()
      }
    }
  })
})
