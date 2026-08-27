import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions } from '../../../providers/types'
import { noCodexResumeLaunch } from '../host-env/codex-resume'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
import { adoptStablePane } from './adopt-stable'
import { agentSessionOwners } from './agent-session-owners'
import { resolveStablePaneOwner, spawnForStablePane } from './stable-owner'

const BINDING_CREATED_AT = 1_000
const RELAY_PROCESS_ID = 'relay-process-1'
const WORKTREE_ID = 'worktree-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const CONNECTION_ID = 'ssh-1'
const APP_PTY_ID = `ssh:${CONNECTION_ID}@@pty-1`
const CLAIMED_OWNER = {
  claim: {
    digestVersion: 1 as const,
    keyId: 'key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'codex' as const
  },
  generation: 'generation-1',
  phase: 'live' as const,
  ptyId: APP_PTY_ID,
  surface: {
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    terminalHandle: 'term-1'
  }
}

type AbsenceFallbackResult = Awaited<ReturnType<typeof spawnForStablePane>> & {
  absenceVerdict: { status: 'live' | 'unverifiable' | 'exited' }
}

function createStore(relayProcessId: string | null | undefined = RELAY_PROCESS_ID): Store {
  let session = {
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: APP_PTY_ID,
          createdAt: BINDING_CREATED_AT
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: APP_PTY_ID }
      }
    }
  } as unknown as WorkspaceSessionState
  return {
    getWorkspaceSession: () => session,
    setWorkspaceSession: (nextSession: WorkspaceSessionState) => {
      session = nextSession as typeof session
    },
    flushOrThrow: vi.fn(),
    getSshRemotePtyLeases: () => [
      {
        targetId: CONNECTION_ID,
        ptyId: 'pty-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        state: 'detached',
        createdAt: BINDING_CREATED_AT,
        updatedAt: BINDING_CREATED_AT,
        ...(relayProcessId ? { relayProcessId } : {})
      }
    ]
  } as unknown as Store
}

function createProvider(relayStatus: unknown): {
  provider: IPtyProvider
  requestHostRpc: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(new Error('PTY "pty-1" not found'))
    .mockResolvedValueOnce({ id: `ssh:${CONNECTION_ID}@@pty-2`, isReattach: false })
  const requestHostRpc =
    relayStatus instanceof Error
      ? vi.fn().mockRejectedValue(relayStatus)
      : vi.fn().mockResolvedValue(relayStatus)
  return {
    provider: { spawn, requestHostRpc } as unknown as IPtyProvider,
    requestHostRpc,
    spawn
  }
}

const STARTUP_INTENT: PtySpawnOptions = {
  cols: 80,
  rows: 24,
  command: 'codex resume session-1',
  commandDelivery: 'provider',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex',
  startupIngress: { colors: { foreground: 'rgb:ffff/ffff/ffff' }, deadlineMs: 1_000 },
  env: { ORCA_AGENT_LAUNCH_TOKEN: 'launch-1', KEEP_ME: 'yes' },
  onPtySpawnCommitted: vi.fn(),
  agentSessionCreateOperationId: 'create-1'
}

async function runFallback(
  relayStatus: unknown,
  bindingRelayProcessId: string | null | undefined = RELAY_PROCESS_ID
): Promise<{
  result: AbsenceFallbackResult
  requestHostRpc: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
  runtime: {
    markPtyLivenessUnverifiable: ReturnType<typeof vi.fn>
    onPtyExit: ReturnType<typeof vi.fn>
  }
}> {
  const store = createStore(bindingRelayProcessId)
  const owner = resolveStablePaneOwner(undefined, store, PANE_KEY, WORKTREE_ID, CONNECTION_ID)
  expect(owner).not.toBeNull()
  const { provider, requestHostRpc, spawn } = createProvider(relayStatus)
  const runtime = {
    markPtyLivenessUnverifiable: vi.fn(),
    onPtyExit: vi.fn()
  }
  const result = (await spawnForStablePane({
    runtime: runtime as never,
    store,
    provider,
    spawnOptions: STARTUP_INTENT,
    owner,
    connectionId: CONNECTION_ID,
    resolveOwner: () => null
  })) as AbsenceFallbackResult
  return { result, requestHostRpc, spawn, runtime }
}

describe('stable pane relay-process-aware absence fallback', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    unregisterSshPtyProvider(CONNECTION_ID)
    vi.useRealTimers()
  })

  it('degrades a binding answered by a replacement relay to unverifiable', async () => {
    const { result, requestHostRpc, spawn, runtime } = await runFallback({
      relayProcessId: 'relay-process-2',
      uptimeMs: Number.MAX_SAFE_INTEGER
    })

    expect(result.absenceVerdict.status).toBe('unverifiable')
    expect(requestHostRpc).toHaveBeenCalledWith('relay.status', {}, expect.any(Object))
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: STARTUP_INTENT.startupIngress,
      env: { KEEP_ME: 'yes' },
      onPtySpawnCommitted: STARTUP_INTENT.onPtySpawnCommitted,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined
    })
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      APP_PTY_ID,
      expect.stringContaining('cannot be proven')
    )
    expect(runtime.onPtyExit).toHaveBeenCalledWith(APP_PTY_ID, -1, undefined)
  })

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['equal to the old binding age', 9_000],
    ['sub-second newer', 9_000.5],
    ['negative', -1],
    ['non-finite', Number.POSITIVE_INFINITY]
  ])(
    'ignores %s uptime when exact relay-process authority is present',
    async (_label, uptimeMs) => {
      const { result, spawn, runtime } = await runFallback({
        relayProcessId: RELAY_PROCESS_ID,
        ...(uptimeMs === undefined ? {} : { uptimeMs })
      })

      expect(result.absenceVerdict.status).toBe('exited')
      expect(spawn.mock.calls[1]?.[0]).toMatchObject({
        command: STARTUP_INTENT.command,
        launchAgent: STARTUP_INTENT.launchAgent
      })
      expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
      expect(runtime.onPtyExit).toHaveBeenCalledWith(APP_PTY_ID, 0, undefined)
    }
  )

  it.each([
    ['persisted lease identity is missing', { relayProcessId: RELAY_PROCESS_ID }, null],
    ['old relay omits process identity', { pid: 42, uptimeMs: 9_000 }, RELAY_PROCESS_ID],
    ['relay identity is malformed', { relayProcessId: 42 }, RELAY_PROCESS_ID],
    ['status request fails', new Error('relay status unavailable'), RELAY_PROCESS_ID],
    [
      'relay restarted while reporting preserved uptime',
      { relayProcessId: 'relay-process-2', uptimeMs: 9_000 },
      RELAY_PROCESS_ID
    ],
    [
      'older relay never owned the process',
      { relayProcessId: 'relay-process-2', uptimeMs: 99_000 },
      RELAY_PROCESS_ID
    ]
  ])('keeps absence unverifiable when %s', async (_label, relayStatus, bindingIdentity) => {
    const { result, spawn, runtime } = await runFallback(relayStatus, bindingIdentity)

    expect(result.absenceVerdict.status).toBe('unverifiable')
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      launchAgent: undefined
    })
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledOnce()
    expect(runtime.onPtyExit).toHaveBeenCalledWith(APP_PTY_ID, -1, undefined)
  })

  it('preserves the old agent ownership fence when absence is unverifiable', async () => {
    agentSessionOwners.register(CLAIMED_OWNER)
    try {
      await runFallback({ relayProcessId: 'relay-process-2' })

      expect(agentSessionOwners.listForPty(APP_PTY_ID)).toEqual([CLAIMED_OWNER])
    } finally {
      agentSessionOwners.release(APP_PTY_ID)
    }
  })

  it('releases the old agent ownership fence after authoritative exit', async () => {
    agentSessionOwners.register(CLAIMED_OWNER)
    try {
      await runFallback({ relayProcessId: RELAY_PROCESS_ID })

      expect(agentSessionOwners.listForPty(APP_PTY_ID)).toEqual([])
    } finally {
      agentSessionOwners.release(APP_PTY_ID)
    }
  })

  it('carries an early adoption verdict into the later full spawn', async () => {
    const store = createStore()
    const { provider, spawn } = createProvider({ relayProcessId: 'relay-process-2' })
    registerSshPtyProvider(CONNECTION_ID, provider)

    const adoption = await adoptStablePane(undefined, store, {
      cols: 80,
      rows: 24,
      connectionId: CONNECTION_ID,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    expect(adoption?.result).toBeNull()
    if (!adoption || adoption.result !== null) {
      throw new Error('expected an absence outcome')
    }
    expect(adoption.absenceVerdict.status).toBe('unverifiable')

    const result = await spawnForStablePane({
      runtime: undefined,
      store,
      provider,
      spawnOptions: STARTUP_INTENT,
      owner: null,
      connectionId: CONNECTION_ID,
      absenceVerdict: adoption.absenceVerdict
    })

    expect(result.absenceVerdict?.status).toBe('unverifiable')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      launchAgent: undefined,
      startupIngress: STARTUP_INTENT.startupIngress,
      env: { KEEP_ME: 'yes' }
    })
  })

  it('suppresses runtime agent-session claims after an unverifiable early adoption', async () => {
    const spawn = vi.fn(async (_options: PtySpawnOptions) => ({
      id: `ssh:${CONNECTION_ID}@@pty-2`
    }))
    registerSshPtyProvider(CONNECTION_ID, {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)

    const result = await spawnPtyFromRuntimeController(
      {
        assertFolderWorkspacePtyPathUsable: vi.fn(),
        resolvePtySpawnStartupCwd: (_worktreeId: string | undefined, cwd: string | undefined) =>
          cwd,
        prepareCodexResumeHome: vi.fn(() => null),
        noCodexResumeLaunch,
        resolveCodexResumeLaunch: vi.fn(),
        reconcileSharedRuntimeResumeHome: vi.fn(),
        stripSequencedStartupResumeArgv: (env: Record<string, string> | undefined) => env,
        getLocalPtyStartupPromise: vi.fn(() => undefined),
        trustedTerminalHandleEnv: new Set(),
        sendPtySpawnedToRenderer: vi.fn()
      } as never,
      {
        cols: 80,
        rows: 24,
        connectionId: CONNECTION_ID,
        command: STARTUP_INTENT.command,
        commandDelivery: STARTUP_INTENT.commandDelivery,
        startupCommandDelivery: STARTUP_INTENT.startupCommandDelivery,
        launchAgent: STARTUP_INTENT.launchAgent,
        env: STARTUP_INTENT.env,
        agentSessionEnsure: {
          claim: { identityDigest: 'claim-digest' },
          surface: {
            worktreeId: WORKTREE_ID,
            tabId: TAB_ID,
            leafId: LEAF_ID,
            terminalHandle: 'term-1'
          }
        },
        stablePaneAbsenceVerdict: {
          status: 'unverifiable',
          reason: 'the answering SSH relay cannot be proven to own the persisted PTY binding'
        }
      } as never
    )

    expect(result.agentStartupSuppressed).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      agentSessionEnsure: undefined,
      env: { KEEP_ME: 'yes' }
    })
  })
})
