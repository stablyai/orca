import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'

export const AUTOMATION_TAB_ID = '55555555-5555-4555-8555-555555555555'
export const AUTOMATION_LEAF_ID = '66666666-6666-4666-8666-666666666666'
export const AUTOMATION_LAUNCH_TOKEN = 'launch-token-automation'

/** Settings every launch-parity case shares; untrimmed default shell on purpose. */
export function launchShellSettings(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    terminalDefaultShell: '  /bin/zsh  ',
    terminalDefaultShellArgs: ['-l'],
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'pwsh.exe',
    // Why off: a fresh agent launch would otherwise write workspace trust into the agent's home.
    agentWorkspaceTrustEnabled: false,
    ...overrides
  }
}

export type LaunchRuntimeStub = {
  setPtyController: Mock
  createPreAllocatedTerminalHandle: Mock
  preAllocateHandleForPty: Mock
  registerPreAllocatedHandleForPty: Mock
  registerPty: Mock
  noteTerminalSpawnCommand: Mock
  onPtySpawned: Mock
  onPtyExit: Mock
  onPtyData: Mock
}

/** Distinct handles so a case shows which allocator main used. */
export function createLaunchRuntimeStub(): LaunchRuntimeStub {
  return {
    setPtyController: vi.fn(),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term_pre_allocated'),
    preAllocateHandleForPty: vi.fn(() => 'term_local_provider'),
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn()
  }
}

export type LaunchStoreStub = {
  persistPtyBinding: Mock
  upsertSshRemotePtyLease: Mock
  supersedeSshRemotePtyLeasesForBoundPane: Mock
  markSshRemotePtyLease: Mock
  removeSshRemotePtyLease: Mock
}

export function createLaunchStoreStub(): LaunchStoreStub {
  return {
    persistPtyBinding: vi.fn(async () => true),
    upsertSshRemotePtyLease: vi.fn(),
    supersedeSshRemotePtyLeasesForBoundPane: vi.fn(),
    markSshRemotePtyLease: vi.fn(),
    removeSshRemotePtyLease: vi.fn()
  }
}

export function registerLaunchHandlers(args: {
  mainWindow: unknown
  runtime?: LaunchRuntimeStub
  settings?: Record<string, unknown>
  store?: LaunchStoreStub
}): void {
  const settings = args.settings
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pty:spawn reads only the window, runtime, settings and store members these fakes define.
  const handlerArgs = [
    args.mainWindow,
    args.runtime,
    undefined,
    settings ? () => settings : undefined,
    undefined,
    args.store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...handlerArgs)
}

/** Registers an SSH relay double whose spawn mock sees the full PtySpawnOptions. */
export function installSshTestProvider(connectionId: string, spawn: Mock): void {
  const provider = {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    acknowledgeDataEvent: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh SSH spawn calls only spawn and the listener registrations defined above.
  const relay = provider as unknown as Parameters<typeof registerSshPtyProvider>[1]
  registerSshPtyProvider(connectionId, relay)
}

/** The first argument of the last provider spawn call. */
export function lastProviderSpawnOptions(spawn: Mock): Record<string, unknown> {
  const options: unknown = spawn.mock.calls.at(-1)?.[0]
  if (!options || typeof options !== 'object') {
    throw new Error('provider spawn was not called')
  }
  return { ...options }
}

/** Only the named keys a case pins, so unrelated spawn fields cannot make it brittle. */
export function pickKeys(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

/** The `pty:spawn` request a desktop automation sends (launch-agent-background-session.ts). */
export function automationSpawnRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const worktreeId =
    typeof overrides.worktreeId === 'string' ? overrides.worktreeId : 'repo-1::/repo'
  return {
    cols: 120,
    rows: 40,
    cwd: '/repo',
    command: "claude '--dangerously-skip-permissions' 'run the automation'",
    env: {
      ORCA_PANE_KEY: `${AUTOMATION_TAB_ID}:${AUTOMATION_LEAF_ID}`,
      ORCA_TAB_ID: AUTOMATION_TAB_ID,
      ORCA_WORKTREE_ID: worktreeId,
      ORCA_AGENT_LAUNCH_TOKEN: AUTOMATION_LAUNCH_TOKEN
    },
    launchConfig: {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    },
    launchToken: AUTOMATION_LAUNCH_TOKEN,
    launchAgent: 'claude',
    connectionId: null,
    worktreeId,
    tabId: AUTOMATION_TAB_ID,
    leafId: AUTOMATION_LEAF_ID,
    placement: { kind: 'new-tab', row: { customTitle: 'Nightly audit' } },
    telemetry: { agent_kind: 'claude-code', launch_source: 'unknown', request_kind: 'new' },
    ...overrides
  }
}
