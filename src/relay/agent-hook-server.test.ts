import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpointDirForRelaySocket, RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import * as agentHookListener from '../shared/agent-hook-listener'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('RelayAgentHookServer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-server-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scopes endpoint files by relay socket path', () => {
    const first = endpointDirForRelaySocket(join(dir, 'relay-a.sock'))
    const second = endpointDirForRelaySocket(join(dir, 'relay-b.sock'))

    expect(first).toBe(join(dir, 'agent-hooks', 'relay-a.sock'))
    expect(second).toBe(join(dir, 'agent-hooks', 'relay-b.sock'))
    expect(first).not.toBe(second)
  })

  it('keeps named-pipe endpoint files on a real filesystem path', () => {
    const endpointDir = endpointDirForRelaySocket('\\\\.\\pipe\\orca-relay-abc123')

    expect(endpointDir).toBe(join(homedir(), '.orca-relay', 'agent-hooks', 'orca-relay-abc123'))
    expect(endpointDir).not.toContain('\\\\.\\pipe')
  })

  it('forwards a parsed Claude UserPromptSubmit POST as a normalized envelope', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
        })
      })
      expect(res.status).toBe(204)
      expect(forward).toHaveBeenCalledTimes(1)
      const envelope = forward.mock.calls[0][0]
      expect(envelope.source).toBe('claude')
      expect(envelope.paneKey).toBe(PANE_KEY)
      expect(envelope.tabId).toBe('tab-1')
      expect(envelope.connectionId).toBeNull()
      expect(envelope.payload.state).toBe('working')
      expect(envelope.payload.prompt).toBe('hi')
      // Why: the relay forwards body env/version so Orca's warn-once
      // protocol diagnostics and remote-location marker survive the wire.
      expect(envelope.env).toBe('remote')
      expect(envelope.version).toBe('1')
    } finally {
      server.stop()
    }
  })

  it('rejects requests with the wrong bearer token (403)', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': 'wrong'
        },
        body: '{}'
      })
      expect(res.status).toBe(403)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('replays cached payloads on demand', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'cache me' }
        })
      })
      forward.mockClear()
      const replayed = server.replayCachedPayloadsForPanes()
      expect(replayed).toBe(1)
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0].payload.prompt).toBe('cache me')
      // Why: replay must preserve the wire envelope's env/version (and source)
      // so protocol diagnostics and the remote-location marker survive replay.
      expect(forward.mock.calls[0][0].source).toBe('claude')
      expect(forward.mock.calls[0][0].env).toBe('remote')
      expect(forward.mock.calls[0][0].version).toBe('1')
      expect(forward.mock.calls[0][0].isReplay).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('does not replay paneKeys after clearPaneState', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'gone' }
        })
      })
      server.clearPaneState(PANE_KEY)
      forward.mockClear()
      const replayed = server.replayCachedPayloadsForPanes()
      expect(replayed).toBe(0)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  // Why: the relay should still drop malformed HTTP events before they reach
  // the wire, even though Orca main re-validates at the SSH trust boundary.
  it('does not forward when normalizeHookPayload rejects the event', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: 'tab-1:0',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          // Why: bogus hook_event_name — normalizeClaudeEvent returns null for
          // any value outside its known set, which propagates up so
          // normalizeHookPayload returns null.
          payload: { hook_event_name: 'BogusEvent', prompt: 'ignored' }
        })
      })
      // Why: hook server fails open with 204 even on rejected input — the
      // contract is "never block the agent", not "tell the agent it lost".
      expect(res.status).toBe(204)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('exposes ORCA_AGENT_HOOK_* env vars after start', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_PORT).toMatch(/^\d+$/)
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_ENV).toBe('remote')
      expect(env.ORCA_AGENT_HOOK_VERSION).toBe('1')
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('can defer endpoint file publication until relay socket ownership is proven', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start({ publishEndpoint: false })
    try {
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(server.publishEndpointFile()).toBe(true)
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('keeps Copilot transcript retry alive across a following SessionEnd event', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const transcriptPath = join(dir, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'Stop', transcriptPath }
        })
      })
      await fetch(`http://127.0.0.1:${port}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'SessionEnd', reason: 'complete' }
        })
      })
      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      // Let the first 50ms retry miss so continuation across SessionEnd is proven.
      await new Promise((resolve) => setTimeout(resolve, 70))
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant.message',
          data: { content: 'Relay transcript completed.' }
        })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe(
        'Relay transcript completed.'
      )
    } finally {
      server.stop()
    }
  })

  it('retries Grok chat history on the relay without blocking the hook POST', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf528'
    const cwd = join(dir, 'workspace')
    const sessionDir = join(dir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'chat_history.jsonl'), '')
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hookEventName: 'user_prompt_submit', prompt: 'hihi' }
        })
      })
      const response = await fetch(`http://127.0.0.1:${port}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hookEventName: 'Stop', sessionId, cwd }
        })
      })

      expect(response.status).toBe(204)
      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'Relay Grok reply.' })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe('Relay Grok reply.')
    } finally {
      server.stop()
      vi.unstubAllEnvs()
    }
  })

  it('caps the replay cache at 256 panes, evicting the least-recently-updated', async () => {
    // Mirrors the server's private MAX_CACHED_PANES. The WSL relay never gets a
    // per-pane teardown signal, so the cache is recency-capped instead.
    const CAP = 256
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const paneKeyFor = (i: number): string => makePaneKey(`tab-${i}`, LEAF_ID)
      const postPane = (paneKey: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({
            paneKey,
            payload: { hook_event_name: 'UserPromptSubmit', prompt: 'p' }
          })
        })

      // Fill the cache to exactly the cap in insertion order 0..CAP-1. Sequential
      // awaits pin Map order = update recency, which the eviction relies on.
      for (let i = 0; i < CAP; i++) {
        await postPane(paneKeyFor(i))
      }
      // Refresh the OLDEST pane just before overflow, then push one more pane.
      // Recency (not insertion) order must now evict pane 1, sparing pane 0.
      await postPane(paneKeyFor(0))
      await postPane(paneKeyFor(CAP))

      forward.mockClear()
      const replayed = server.replayCachedPayloadsForPanes()
      expect(replayed).toBe(CAP)

      const cachedPaneKeys = new Set(forward.mock.calls.map((call) => call[0].paneKey))
      expect(cachedPaneKeys.size).toBe(CAP)
      expect(cachedPaneKeys.has(paneKeyFor(0))).toBe(true)
      expect(cachedPaneKeys.has(paneKeyFor(CAP))).toBe(true)
      expect(cachedPaneKeys.has(paneKeyFor(1))).toBe(false)
    } finally {
      server.stop()
    }
  }, 30_000)

  it('forwards a Grok result when discovery finishes after the old retry window', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf534'
    const cwd = join(dir, 'workspace')
    const sessionDir = join(dir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const history = join(sessionDir, 'chat_history.jsonl')
    writeFileSync(history, '')
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/grok`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            env: 'remote',
            version: '1',
            payload
          })
        })

      await post({ hookEventName: 'UserPromptSubmit', prompt: 'delayed relay result' })
      await post({ hookEventName: 'Stop', sessionId, cwd })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      writeFileSync(
        history,
        `${JSON.stringify({ type: 'assistant', content: 'Relay found after discovery.' })}\n`
      )
      releaseDiscovery()

      await vi.waitFor(() => {
        expect(forward.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe(
          'Relay found after discovery.'
        )
      })
    } finally {
      server.stop()
      vi.unstubAllEnvs()
    }
  })

  it('does not forward an old result over a newer same-text Grok turn', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/grok`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            env: 'remote',
            version: '1',
            payload
          })
        })

      await post({ hookEventName: 'UserPromptSubmit', prompt: 'repeat me' })
      await post({
        hookEventName: 'Stop',
        sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf535',
        cwd: join(dir, 'workspace')
      })
      await post({ hookEventName: 'UserPromptSubmit', prompt: 'repeat me' })
      const forwardsBeforeDiscovery = forward.mock.calls.length

      releaseDiscovery()
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(forward).toHaveBeenCalledTimes(forwardsBeforeDiscovery)
      expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({
        state: 'working',
        prompt: 'repeat me',
        agentType: 'grok'
      })
    } finally {
      server.stop()
    }
  })
})
