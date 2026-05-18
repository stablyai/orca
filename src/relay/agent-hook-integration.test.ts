/**
 * End-to-end agent-status-over-SSH integration test.
 *
 * Wires Orca's main-side SshChannelMultiplexer to the relay-side
 * RelayDispatcher through an in-memory pipe and starts a real
 * RelayAgentHookServer. POSTs a hook event to the relay's loopback HTTP
 * receiver and asserts the parsed payload arrives in `agentHookServer`'s
 * onAgentStatus listener through the `agent.hook` JSON-RPC notification path.
 *
 * This is the test the design doc (§9 step 5/6) calls "the SSH provider gets
 * at least one integration test that round-trips a hook event from a remote
 * PTY back to AgentStatus state."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import { RelayDispatcher } from './dispatcher'
import { RelayAgentHookServer } from './agent-hook-server'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { AgentHookServer } from '../main/agent-hooks/server'

const LEAF_7 = '77777777-7777-4777-8777-777777777777'
const LEAF_9 = '99999999-9999-4999-8999-999999999999'

describe('Integration: relay hook server → mux → AgentHookServer.ingestRemote', () => {
  let tmpDir: string
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let hookServer: RelayAgentHookServer
  let orcaServer: AgentHookServer

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-hook-e2e-'))

    let relayFeedFn: ((data: Buffer) => void) | undefined
    const clientDataCallbacks: ((data: Buffer) => void)[] = []

    const clientTransport: MultiplexerTransport = {
      write: (data: Buffer) => {
        setImmediate(() => relayFeedFn?.(data))
      },
      onData: (cb) => {
        clientDataCallbacks.push(cb)
      },
      // Why: MultiplexerTransport.onClose is a required field; the test never
      // simulates a transport close, so register a no-op rather than tracking
      // callbacks that nothing invokes.
      onClose: () => {}
    }

    dispatcher = new RelayDispatcher((data: Buffer) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
      })
    })
    relayFeedFn = (data: Buffer) => dispatcher.feed(data)

    hookServer = new RelayAgentHookServer({
      endpointDir: tmpDir,
      forward: (envelope) => {
        dispatcher.notify(
          AGENT_HOOK_NOTIFICATION_METHOD,
          envelope as unknown as Record<string, unknown>
        )
      }
    })
    await hookServer.start()

    dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
      const replayed = hookServer.replayCachedPayloadsForPanes()
      return { replayed }
    })

    mux = new SshChannelMultiplexer(clientTransport)

    orcaServer = new AgentHookServer()
    // Why: Orca-side never starts an HTTP server in this test — `ingestRemote`
    // is the entry point we exercise. setListener registers the IPC fanout
    // sink we assert against. Server is otherwise inert.
    mux.onNotification((method, params) => {
      if (method === AGENT_HOOK_NOTIFICATION_METHOD) {
        // Why: `connectionId` is normally derived from the mux identity at
        // the call site. For the in-memory test we use a fixed string.
        orcaServer.ingestRemote(
          params as unknown as {
            paneKey: string
            tabId?: string
            worktreeId?: string
            payload: unknown
          },
          'conn-test'
        )
      }
    })
  })

  afterEach(async () => {
    mux.dispose()
    dispatcher.dispose()
    hookServer.stop()
    orcaServer.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('forwards a Claude UserPromptSubmit POST through to ingestRemote', async () => {
    const events: { paneKey: string; payload: unknown; connectionId: string | null }[] = []
    orcaServer.setListener((event) => {
      events.push({
        paneKey: event.paneKey,
        payload: event.payload,
        connectionId: event.connectionId
      })
    })

    const { port, token } = hookServer.getCoordinates()
    const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: `tab-7:${LEAF_7}`,
        tabId: 'tab-7',
        worktreeId: 'wt-7',
        env: 'remote',
        version: '1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'roundtrip' }
      })
    })
    expect(res.status).toBe(204)

    // Why: dispatcher → transport setImmediate → mux feed → handler all run
    // on the next tick(s); spin until our sink captures the event or we
    // hit a generous timeout.
    const start = Date.now()
    while (events.length === 0 && Date.now() - start < 1500) {
      await new Promise((r) => setImmediate(r))
    }
    expect(events).toHaveLength(1)
    expect(events[0].paneKey).toBe(`tab-7:${LEAF_7}`)
    expect(events[0].connectionId).toBe('conn-test')
    const payload = events[0].payload as { state: string; prompt: string; agentType: string }
    expect(payload.state).toBe('working')
    expect(payload.prompt).toBe('roundtrip')
    expect(payload.agentType).toBe('claude')
  })

  it('replays the cached last-status on agent_hook.requestReplay', async () => {
    // Why: register the listener BEFORE the initial POST so live notifications
    // are observed. setListener on a non-empty cache replays cached entries
    // synchronously; if we set it AFTER the POST drains, the assertion below
    // would pass without the relay's replay actually crossing the wire.
    const events: { paneKey: string; payload: unknown }[] = []
    orcaServer.setListener((event) => {
      events.push({ paneKey: event.paneKey, payload: event.payload })
    })

    const { port, token } = hookServer.getCoordinates()
    await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: `tab-9:${LEAF_9}`,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'cached' }
      })
    })

    // Why: spin until the live notification arrives so the replay request
    // below produces a strictly-second event in `events`.
    const liveStart = Date.now()
    while (events.length === 0 && Date.now() - liveStart < 1500) {
      await new Promise((r) => setImmediate(r))
    }
    expect(events).toHaveLength(1)

    const result = (await mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD)) as {
      replayed: number
    }
    expect(result.replayed).toBe(1)

    // Why: relay-side replay produces a fresh notification; spin until it
    // arrives so the assertion below proves the round-trip (relay → wire →
    // mux → ingestRemote → listener) rather than just the relay-side count.
    const replayStart = Date.now()
    while (events.length < 2 && Date.now() - replayStart < 1500) {
      await new Promise((r) => setImmediate(r))
    }
    expect(events).toHaveLength(2)
    expect(events[1].paneKey).toBe(`tab-9:${LEAF_9}`)
  })
})
