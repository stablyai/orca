import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { RelayAgentHookRuntime } from './relay-agent-hook-runtime'
import { RetiredPaneSurfaceRegistry } from './retired-pane-surfaces'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { PtyHandler, PtySurfaceRetiredListener } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function hookMeta(paneKey: string): string {
  return Buffer.from([paneKey, 'tab-1', '', 'wt-1', 'remote', '1'].join('\x1f')).toString('base64')
}

async function postHook(
  server: RelayAgentHookServer,
  paneKey: string,
  prompt = 'hi'
): Promise<number> {
  const { port, token } = server.getCoordinates()
  const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': token,
      'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
      'X-Orca-Agent-Hook-Meta': hookMeta(paneKey)
    },
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt })
  })
  return res.status
}

type CachedPanes = { state: { lastStatusByPaneKey: Map<string, unknown> } }

function cachedPaneKeys(server: RelayAgentHookServer): string[] {
  return [...(server as unknown as CachedPanes).state.lastStatusByPaneKey.keys()]
}

describe('relay hook forwarding for a retired pane surface', () => {
  let dir: string
  let servers: RelayAgentHookServer[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-retired-pane-'))
    servers = []
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(options: {
    forward: (envelope: AgentHookRelayEnvelope) => void
    isPaneSurfaceRetired?: (paneKey: string) => boolean
  }): Promise<RelayAgentHookServer> {
    const server = new RelayAgentHookServer({ endpointDir: dir, ...options })
    servers.push(server)
    await server.start({ publishEndpoint: false })
    return server
  }

  it('forwards and caches a post from a pane that still has a tab', async () => {
    const retired = new RetiredPaneSurfaceRegistry()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = await startServer({
      forward,
      isPaneSurfaceRetired: (paneKey) => retired.isRetired(paneKey)
    })

    expect(await postHook(server, PANE_KEY)).toBe(204)

    expect(forward).toHaveBeenCalledTimes(1)
    expect(cachedPaneKeys(server)).toEqual([PANE_KEY])
  })

  it('does not advertise an orphan agent whose tab was closed', async () => {
    const retired = new RetiredPaneSurfaceRegistry()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = await startServer({
      forward,
      isPaneSurfaceRetired: (paneKey) => retired.isRetired(paneKey)
    })

    expect(await postHook(server, PANE_KEY, 'first')).toBe(204)
    forward.mockClear()

    // The user closes the tab; the agent inside the pane shell survives and keeps posting.
    retired.retire(PANE_KEY)
    expect(await postHook(server, PANE_KEY, 'orphan')).toBe(204)

    expect(forward).not.toHaveBeenCalled()
    // The pre-close status must go too, or a reconnect replays it as a live agent pane.
    expect(cachedPaneKeys(server)).toEqual([])
  })

  it('does not replay a cached status for a pane retired after it was cached', async () => {
    const retired = new RetiredPaneSurfaceRegistry()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = await startServer({
      forward,
      isPaneSurfaceRetired: (paneKey) => retired.isRetired(paneKey)
    })

    expect(await postHook(server, PANE_KEY)).toBe(204)
    forward.mockClear()
    retired.retire(PANE_KEY)

    expect(server.replayCachedPayloadsForPanes()).toBe(0)
    expect(forward).not.toHaveBeenCalled()
    expect(cachedPaneKeys(server)).toEqual([])
  })

  it('forwards again once the pane key is bound by a new PTY', async () => {
    const retired = new RetiredPaneSurfaceRegistry()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = await startServer({
      forward,
      isPaneSurfaceRetired: (paneKey) => retired.isRetired(paneKey)
    })

    retired.retire(PANE_KEY)
    expect(await postHook(server, PANE_KEY, 'orphan')).toBe(204)
    expect(forward).not.toHaveBeenCalled()

    retired.restore(PANE_KEY)
    expect(await postHook(server, PANE_KEY, 'reopened')).toBe(204)

    expect(forward).toHaveBeenCalledTimes(1)
  })

  it('an embedder that supplies no retirement source keeps forwarding everything', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = await startServer({ forward })

    expect(await postHook(server, PANE_KEY)).toBe(204)

    expect(forward).toHaveBeenCalledTimes(1)
    expect(cachedPaneKeys(server)).toEqual([PANE_KEY])
  })
})

describe('RelayAgentHookRuntime wiring', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-retired-pane-runtime-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('routes hook admission through the PTY handler and drops the cache on retirement', async () => {
    const retired = new RetiredPaneSurfaceRegistry()
    const surfaceRetiredListeners: PtySurfaceRetiredListener[] = []
    const ptyHandler = {
      addEnvAugmenter: vi.fn(),
      setExitListener: vi.fn(),
      setSurfaceRetiredListener: vi.fn((listener: PtySurfaceRetiredListener | null) => {
        if (listener) {
          surfaceRetiredListeners.push(listener)
        }
      }),
      isPaneSurfaceRetired: (paneKey: string) => retired.isRetired(paneKey)
    } as unknown as PtyHandler
    // Zero attached clients: publishAgentHookEnvelope returns before touching any sink.
    const dispatcher = {
      onRequest: vi.fn(),
      activeClientIds: () => [] as number[]
    } as unknown as RelayDispatcher

    const runtime = new RelayAgentHookRuntime(
      dispatcher,
      ptyHandler,
      join(dir, 'relay.sock'),
      join(dir, 'hooks')
    )
    await runtime.start()
    try {
      const server = (runtime as unknown as { hookServer: RelayAgentHookServer }).hookServer
      expect(await postHook(server, PANE_KEY)).toBe(204)
      expect(cachedPaneKeys(server)).toEqual([PANE_KEY])

      // The PTY handler retires the surface: the runtime must drop the cached status immediately,
      // rather than waiting for a process exit a surviving shell never produces.
      retired.retire(PANE_KEY)
      expect(surfaceRetiredListeners).toHaveLength(1)
      surfaceRetiredListeners[0]({ id: 'pty-1', paneKey: PANE_KEY })
      expect(cachedPaneKeys(server)).toEqual([])

      expect(await postHook(server, PANE_KEY, 'orphan')).toBe(204)
      expect(cachedPaneKeys(server)).toEqual([])
    } finally {
      runtime.stop()
    }
  })
})
