import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderRelayChannel,
  ProviderRelaySink
} from '../../../provider-relay/provider-relay-channel'
import { RelayedProviderChild } from '../../../provider-relay/relayed-provider-child'
import { relayedManagedProcess } from '../../../provider-relay/relayed-managed-process'
import { createAcpAgentConnection } from '../acp-agent-connection'
import type { AcpSessionEvent } from '../../protocol/acp-session-events'
import { acpKeptAgent, restorableAcpSession } from '../acp-kept-agent'
import { AcpRelayTurns } from '../acp-relay-turns'

const policy = () => ({ idleStopMs: null, markers: [] })
const line = (message: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: '2.0', ...message })
const update = (sessionUpdate: string, rest: Record<string, unknown>): string =>
  line({
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate, ...rest } }
  })

/** A kept ACP agent as the daemon hands it back: what it kept, then its spool; `exits` ends it mid-attach. */
function keptAgent(exits: boolean) {
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
        maxClientRequestId: 2,
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
  return { child, writes, closes }
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
})
