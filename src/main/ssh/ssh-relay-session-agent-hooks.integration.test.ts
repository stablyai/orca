/* eslint-disable max-lines -- Why: this integration spec keeps the SSH relay,
agent-hook server, and replay/interrupt ordering fixtures together so regressions
cover the full mux-to-main path. */
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
import { toAppSshPtyId } from '../providers/ssh-pty-id'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { SshRelaySession } = await import('./ssh-relay-session')

const SSH_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const REPLAY_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const BAD_LEAF_ID = '33333333-3333-4333-8333-333333333333'

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
    paneKey: `tab-ssh:${SSH_LEAF_ID}`,
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
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 4 })
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
        ORCA_PANE_KEY: `tab-ssh:${SSH_LEAF_ID}`,
        ORCA_TAB_ID: 'tab-ssh',
        ORCA_WORKTREE_ID: 'wt-ssh'
      }
    })

    expect(spawn.id).toBe(toAppSshPtyId('conn-fake', 'remote-pty-1'))
    expect(relay.ptySpawnRequests).toHaveLength(1)
    expect(relay.ptySpawnRequests[0]).toMatchObject({
      cwd: '/home/orca/project',
      env: {
        ORCA_PANE_KEY: `tab-ssh:${SSH_LEAF_ID}`,
        ORCA_TAB_ID: 'tab-ssh',
        ORCA_WORKTREE_ID: 'wt-ssh'
      }
    })

    relay.notifyAgentHook(makeEnvelope())

    await waitForStatusCount(events, 1)
    expect(events[0]).toEqual({
      paneKey: `tab-ssh:${SSH_LEAF_ID}`,
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
        paneKey: `tab-replay:${REPLAY_LEAF_ID}`,
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
      paneKey: `tab-replay:${REPLAY_LEAF_ID}`,
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
      paneKey: `tab-bad:${BAD_LEAF_ID}`,
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

  it('preserves explicit-prompt metadata from remote hook notifications', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })

    session = createSession('conn-explicit-prompt')
    await session.establish({} as SshConnection)

    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        payload: {
          state: 'working',
          prompt: 'retry same prompt',
          agentType: 'opencode',
          lastAssistantMessage: 'partial answer'
        }
      })
    )
    await vi.waitFor(() => expect(agentHookServer.getStatusSnapshot()).toHaveLength(1), {
      timeout: 1500
    })
    const first = agentHookServer.getStatusSnapshot()[0]

    expect(
      agentHookServer.inferInterrupt({
        paneKey: first.paneKey,
        baselineUpdatedAt: first.receivedAt,
        baselineStateStartedAt: first.stateStartedAt,
        baselinePrompt: 'retry same prompt',
        baselineAgentType: 'opencode',
        intent: 'ctrl-c'
      })
    ).toBe(true)

    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        payload: {
          state: 'working',
          prompt: 'retry same prompt',
          agentType: 'opencode',
          lastAssistantMessage: 'partial answer'
        }
      })
    )

    await vi.waitFor(() =>
      expect(agentHookServer.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'retry same prompt',
        agentType: 'opencode',
        lastAssistantMessage: 'partial answer'
      })
    )
  })

  it('forwards remote hook transition metadata into main ingest', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })
    const ingestSpy = vi.spyOn(agentHookServer, 'ingestRemote')

    session = createSession('conn-hook-metadata')
    await session.establish({} as SshConnection)

    relay.notifyAgentHook(
      makeEnvelope({
        source: 'claude',
        hookEventName: 'PreToolUse',
        promptInteractionKey: 'command-code-transcript-user-3',
        toolUseId: 'toolu-1',
        toolAgentId: 'agent-subagent-a',
        toolAgentType: 'Review',
        providerSession: { key: 'session_id', id: 'ssh-relay-session-1' },
        payload: {
          state: 'working',
          prompt: 'remote prompt',
          agentType: 'claude',
          toolName: 'Bash',
          toolInput: 'pnpm test'
        }
      })
    )

    await vi.waitFor(() =>
      expect(ingestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'PreToolUse',
          promptInteractionKey: 'command-code-transcript-user-3',
          toolUseId: 'toolu-1',
          toolAgentId: 'agent-subagent-a',
          toolAgentType: 'Review',
          providerSession: { key: 'session_id', id: 'ssh-relay-session-1' }
        }),
        'conn-hook-metadata'
      )
    )
    ingestSpy.mockRestore()
  })

  it('tracks prompt sent from live SSH agent hooks but not replayed hooks', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })

    session = createSession('conn-live-telemetry')
    await session.establish({} as SshConnection)

    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        payload: {
          state: 'working',
          prompt: 'ssh live user prompt',
          agentType: 'codex'
        }
      })
    )

    await vi.waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', {
        agent_kind: 'codex',
        launch_source: 'unknown',
        request_kind: 'followup',
        nth_repo_added: 4
      })
    )

    trackMock.mockClear()
    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        isReplay: true,
        payload: {
          state: 'working',
          prompt: 'ssh replayed user prompt',
          agentType: 'codex'
        }
      })
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(trackMock).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('preserves replay metadata from remote hook notifications', async () => {
    relay = createFakeRelay()
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: relay.transport,
      platform: 'linux-x64'
    })

    session = createSession('conn-replay-marker')
    await session.establish({} as SshConnection)

    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        payload: {
          state: 'working',
          prompt: 'replayed prompt',
          agentType: 'opencode'
        }
      })
    )
    await vi.waitFor(() => expect(agentHookServer.getStatusSnapshot()).toHaveLength(1), {
      timeout: 1500
    })
    const first = agentHookServer.getStatusSnapshot()[0]

    expect(
      agentHookServer.inferInterrupt({
        paneKey: first.paneKey,
        baselineUpdatedAt: first.receivedAt,
        baselineStateStartedAt: first.stateStartedAt,
        baselinePrompt: 'replayed prompt',
        baselineAgentType: 'opencode',
        intent: 'ctrl-c'
      })
    ).toBe(true)

    relay.notifyAgentHook(
      makeEnvelope({
        hasExplicitPrompt: true,
        isReplay: true,
        payload: {
          state: 'working',
          prompt: 'replayed prompt',
          agentType: 'opencode'
        }
      })
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(agentHookServer.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      prompt: 'replayed prompt',
      agentType: 'opencode',
      interrupted: true
    })
  })
})
