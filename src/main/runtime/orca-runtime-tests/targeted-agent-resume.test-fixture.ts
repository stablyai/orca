import { vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { PtyProcessInfo } from '../../providers/pty-provider-contract'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'

export const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
export const SESSION = { key: 'session_id', id: 'provider-session-1' } as const
export const MUTATION_ID = '["dev","thread-1","delivery-1"]'
export function makeSleptWorkspace() {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: SESSION,
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
  }
  return makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
}

export type Fixture = ReturnType<typeof makeSleptWorkspace>

export function sessionRow(paneKey: string, receivedAt = 0): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume guards read only paneKey, providerSession and the observation clocks.
  return { paneKey, providerSession: SESSION, receivedAt } as never
}

export function makeRuntime(
  fixture: Fixture,
  opts: {
    spawn?: NonNullable<RuntimePtyController['spawn']>
    rows?: () => AgentStatusIpcPayload[]
    checkHookAgentPresence?: () => Promise<'live' | 'unverifiable' | 'exited' | null>
    listProcesses?: () => Promise<PtyProcessInfo[]>
    subscribeAgentProviderSessionChanges?: (
      listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
    ) => () => void
  } = {}
) {
  const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(
    opts.spawn ?? (() => Promise.resolve({ id: 'resumed-pty' }))
  )
  const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
    getDesktopWindowStatus: () => 'openable',
    ...(opts.rows ? { getAgentProviderSessionSnapshot: opts.rows } : {}),
    ...(opts.checkHookAgentPresence ? { checkHookAgentPresence: opts.checkHookAgentPresence } : {}),
    ...(opts.subscribeAgentProviderSessionChanges
      ? { subscribeAgentProviderSessionChanges: opts.subscribeAgentProviderSessionChanges }
      : {})
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: opts.listProcesses ?? (async () => [])
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  const attachWindow = (webContents?: { send: (...args: unknown[]) => void }): void => {
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      ...(webContents ? { webContents } : {})
    })
  }
  const resume = (
    overrides: {
      captureHostId?: 'local' | `ssh:${string}`
      mutationId?: string
      signal?: AbortSignal
    } = {}
  ) =>
    runtime.resumeAgentSessionInWorkspace(TEST_WORKTREE_ID, {
      agent: 'claude',
      providerSession: SESSION,
      captureHostId: overrides.captureHostId ?? 'local',
      mutationId: overrides.mutationId ?? MUTATION_ID,
      signal: overrides.signal
    })
  const openOldPane = () =>
    runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  return { runtime, spawn, attachWindow, resume, openOldPane }
}

export function spawnedCommands(spawn: ReturnType<typeof vi.fn>): string[] {
  return spawn.mock.calls.map(([args]: unknown[]) =>
    typeof args === 'object' && args !== null && 'command' in args ? String(args.command ?? '') : ''
  )
}

export function resumeSpawns(spawn: ReturnType<typeof vi.fn>): number {
  return spawnedCommands(spawn).filter((command) => command.includes('provider-session-1')).length
}

export function storedRecord(fixture: Fixture) {
  return fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}
