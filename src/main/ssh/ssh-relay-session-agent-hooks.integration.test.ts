import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Store } from '../persistence'
import type { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayDispatcher } from '../../relay/dispatcher'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD,
  ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV,
  REMOTE_AGENT_HOOK_ENV
} from '../../shared/agent-hook-relay'
import { agentHookServer, _internals as agentHookInternals } from '../agent-hooks/server'
import { getSshPtyProvider } from '../ipc/pty'

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { SshRelaySession } = await import('./ssh-relay-session')

type CapturedStatus = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  payload: {
    state: string
    prompt: string
    agentType?: string
    toolName?: string
  }
}

type FakeRelay = {
  transport: MultiplexerTransport
  dispatcher: RelayDispatcher
  ptySpawnRequests: Record<string, unknown>[]
  replayEnvelopes: AgentHookRelayEnvelope[]
  notifyAgentHook: (envelope: AgentHookRelayEnvelope | Record<string, unknown>) => void
  dispose: () => void
}

// Why: mock below SSH at the relay transport boundary so CI covers session,
// mux, provider, and hook-ingest wiring without relying on a local sshd.
function createFakeRelay(): FakeRelay {
  let relayFeed: ((data: Buffer) => void) | null = null
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const clientCloseCallbacks: (() => void)[] = []
  const ptySpawnRequests: Record<string, unknown>[] = []
  const replayEnvelopes: AgentHookRelayEnvelope[] = []

  const transport: MultiplexerTransport = {
    write: (data) => {
      setImmediate(() => relayFeed?.(data))
    },
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: (cb) => {
      clientCloseCallbacks.push(cb)
    },
    close: () => {
      for (const cb of clientCloseCallbacks) {
        cb()
      }
    }
  }

  const dispatcher = new RelayDispatcher((data) => {
    setImmediate(() => {
      for (const cb of clientDataCallbacks) {
        cb(data)
      }
    })
  })
  relayFeed = (data) => dispatcher.feed(data)

  dispatcher.onRequest('session.resolveHome', async (params) => ({
    resolvedPath: params.path === '~' ? '/home/orca' : params.path
  }))
  dispatcher.onRequest('git.listWorktrees', async () => [])
  dispatcher.onRequest('ports.detect', async () => ({ ports: [], platform: 'linux' }))
  dispatcher.onRequest('pty.spawn', async (params) => {
    ptySpawnRequests.push(params)
    return { id: `remote-pty-${ptySpawnRequests.length}` }
  })
  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
    // Why: relay replay must arrive after Orca wires its listener and before
    // the request resolves, matching the real relay ordering contract.
    for (const envelope of replayEnvelopes) {
      dispatcher.notify(
        AGENT_HOOK_NOTIFICATION_METHOD,
        envelope as unknown as Record<string, unknown>
      )
    }
    return { replayed: replayEnvelopes.length }
  })

  return {
    transport,
    dispatcher,
    ptySpawnRequests,
    replayEnvelopes,
    notifyAgentHook: (envelope) => {
      dispatcher.notify(AGENT_HOOK_NOTIFICATION_METHOD, envelope as Record<string, unknown>)
    },
    dispose: () => dispatcher.dispose()
  }
}

function createSession(targetId: string): InstanceType<typeof SshRelaySession> {
  const store = {
    getRepos: vi.fn().mockReturnValue([]),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn()
  } as unknown as Store
  const portForwardManager = {
    removeAllForwards: vi.fn().mockResolvedValue(undefined)
  } as unknown as SshPortForwardManager
  const getMainWindow = vi.fn().mockReturnValue({
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
  return new SshRelaySession(targetId, getMainWindow, store, portForwardManager)
}

async function waitForStatusCount(events: CapturedStatus[], count: number): Promise<void> {
  await vi.waitFor(() => expect(events).toHaveLength(count), { timeout: 1500 })
}

function captureAgentStatuses(events: CapturedStatus[]): void {
  agentHookServer.setListener((event) => {
    events.push({
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      connectionId: event.connectionId,
      payload: {
        state: event.payload.state,
        prompt: event.payload.prompt,
        agentType: event.payload.agentType,
        toolName: event.payload.toolName
      }
    })
  })
}

function makeEnvelope(overrides: Partial<AgentHookRelayEnvelope> = {}): AgentHookRelayEnvelope {
  return {
    source: 'codex',
    paneKey: 'tab-ssh:0',
    tabId: 'tab-ssh',
    worktreeId: 'wt-ssh',
    connectionId: null,
    env: REMOTE_AGENT_HOOK_ENV,
    version: '1',
    payload: {
      state: 'working',
      prompt: 'remote prompt',
      agentType: 'codex'
    },
    ...overrides
  }
}

describe('SshRelaySession agent hooks over a fake relay transport', () => {
  let previousRemoteHooksFlag: string | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>
  let session: InstanceType<typeof SshRelaySession> | null = null
  let relay: FakeRelay | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    previousRemoteHooksFlag = process.env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]
    process.env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV] = '1'
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    agentHookServer.setListener(null)
    agentHookInternals.resetCachesForTests()
  })

  afterEach(() => {
    session?.dispose()
    relay?.dispose()
    session = null
    relay = null
    agentHookServer.setListener(null)
    agentHookInternals.resetCachesForTests()
    warnSpy.mockRestore()
    if (previousRemoteHooksFlag === undefined) {
      delete process.env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV]
    } else {
      process.env[ORCA_FEATURE_REMOTE_AGENT_HOOKS_ENV] = previousRemoteHooksFlag
    }
  })

  it('establishes through a fake relay, spawns a remote PTY, and forwards agent status', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })
    const events: CapturedStatus[] = []
    captureAgentStatuses(events)

    session = createSession('conn-fake')
    await session.establish({} as SshConnection)

    const provider = getSshPtyProvider('conn-fake')
    expect(provider).toBeDefined()
    const spawn = await provider!.spawn({
      cols: 120,
      rows: 40,
      cwd: '/home/orca/project',
      env: {
        ORCA_PANE_KEY: 'tab-ssh:0',
        ORCA_TAB_ID: 'tab-ssh',
        ORCA_WORKTREE_ID: 'wt-ssh'
      }
    })

    expect(spawn.id).toBe('remote-pty-1')
    expect(relay.ptySpawnRequests).toHaveLength(1)
    expect(relay.ptySpawnRequests[0]).toMatchObject({
      cwd: '/home/orca/project',
      env: {
        ORCA_PANE_KEY: 'tab-ssh:0',
        ORCA_TAB_ID: 'tab-ssh',
        ORCA_WORKTREE_ID: 'wt-ssh'
      }
    })

    relay.notifyAgentHook(makeEnvelope())

    await waitForStatusCount(events, 1)
    expect(events[0]).toEqual({
      paneKey: 'tab-ssh:0',
      tabId: 'tab-ssh',
      worktreeId: 'wt-ssh',
      connectionId: 'conn-fake',
      payload: {
        state: 'working',
        prompt: 'remote prompt',
        agentType: 'codex',
        toolName: undefined
      }
    })
  })

  it('asks the fake relay for cached hook replay after the session wires its listener', async () => {
    relay = createFakeRelay()
    relay.replayEnvelopes.push(
      makeEnvelope({
        paneKey: 'tab-replay:0',
        tabId: 'tab-replay',
        worktreeId: 'wt-replay',
        payload: {
          state: 'waiting',
          prompt: 'cached remote prompt',
          agentType: 'claude',
          toolName: 'Bash'
        }
      })
    )
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })
    const events: CapturedStatus[] = []
    captureAgentStatuses(events)

    session = createSession('conn-replay')
    await session.establish({} as SshConnection)

    await waitForStatusCount(events, 1)
    expect(events[0]).toMatchObject({
      paneKey: 'tab-replay:0',
      tabId: 'tab-replay',
      worktreeId: 'wt-replay',
      connectionId: 'conn-replay',
      payload: {
        state: 'waiting',
        prompt: 'cached remote prompt',
        agentType: 'claude',
        toolName: 'Bash'
      }
    })
  })

  it('drops malformed remote hook notifications at Orca main before caching', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })
    const events: CapturedStatus[] = []
    captureAgentStatuses(events)

    session = createSession('conn-validate')
    await session.establish({} as SshConnection)

    relay.notifyAgentHook({
      source: 'codex',
      paneKey: 'tab-bad:0',
      connectionId: null,
      env: REMOTE_AGENT_HOOK_ENV,
      version: '1',
      payload: {
        state: 'not-a-real-state',
        prompt: 'should not be cached',
        agentType: 'codex'
      }
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(0)
    expect(agentHookServer.getStatusSnapshot()).toEqual([])
  })
})
