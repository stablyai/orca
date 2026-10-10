// Test-only: the host-lane launch parity table (rows 3, 4, 5r, 7, 8, 10). Each case is the call a
// host producer makes and the facts main hands the provider, the phone and telemetry for it.
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import type { LaunchWorkspace } from '../../shared/launch-parity-window-request.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'

export const HOST_TAB_ID = '33333333-3333-4333-8333-333333333333'
export const HOST_LEAF_ID = '44444444-4444-4444-8444-444444444444'

export type HostLaunchCall =
  | { kind: 'create'; options: TerminalCreateOptions }
  /** A paired client's RPC, run through the host's method handler; clientOperationId is added. */
  | {
      kind: 'rpc'
      method: 'terminal.create' | 'terminal.createAgentSession'
      params: Record<string, unknown>
    }

export type HostProviderFacts = {
  command: string
  /** Default: the workspace path. */
  cwd?: string
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  startupCommandDelivery?: 'shell-ready'
  /** The agent or caller env keys the case set, with their values; default none. */
  env?: Record<string, string>
  /** Whether main marks the PTY hidden before it has a view; default true on this lane. */
  hidden?: boolean
}

export type HostLaunchCase = {
  name: string
  /** The launch-convergence producer row. */
  row: '3' | '4' | '5r' | '7' | '8' | '10'
  os: NodeJS.Platform
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  call: HostLaunchCall
  provider: HostProviderFacts
  /** agent_started payload, or null when main emits none. */
  telemetry: Record<string, string> | null
  /** The phone's first session tab. */
  phone: { title: string; launchAgent?: string; isActive: boolean }
}

// rpc/methods/agent-launch-surfaces.ts createTerminalAgent options for an AI button's reserved pane.
const agentLaunch = (extra: Record<string, unknown> = {}): HostLaunchCall => ({
  kind: 'create',
  options: {
    startupAgent: 'claude',
    tabId: HOST_TAB_ID,
    leafId: HOST_LEAF_ID,
    requireFreshPane: true,
    launchSource: 'task_page',
    viewMode: 'terminal',
    surfaceOwner: false,
    ...extra
  }
})
// worker-topology.ts createExistingWorktreeWorkerTerminal options.
const worker: HostLaunchCall = {
  kind: 'create',
  options: {
    startupAgent: 'claude',
    launchSource: 'orchestration',
    title: 'worker-task-1',
    surfaceOwner: false
  }
}

export const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
export const folder = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'folder',
  path,
  ...extra
})
// The same factory for a mobile quick command (agent.launchReplay with a reserved pane and a
// prompt): a paired phone never moves the host window.
const mobileQuickCommand = (startupPrompt: string): HostLaunchCall => ({
  kind: 'create',
  options: {
    startupAgent: 'codex',
    startupPrompt,
    launchSource: 'quick_command',
    tabId: HOST_TAB_ID,
    leafId: HOST_LEAF_ID,
    requireFreshPane: true,
    viewMode: 'terminal',
    surfaceOwner: false
  }
})
const TASK_PAGE = { agent_kind: 'claude-code', launch_source: 'task_page', request_kind: 'new' }
// The AI button that reaches each workspace kind: fix checks needs a repo with a PR (task_page);
// in a folder, review notes' "New agent" (also on browser and markdown annotations, notes_send).
const aiButtonSource = (workspace: LaunchWorkspace): string =>
  workspace.kind === 'repo' ? 'task_page' : 'notes_send'
const QUICK_COMMAND = { agent_kind: 'codex', launch_source: 'quick_command', request_kind: 'new' }
export const AGENT_PHONE = { title: 'Terminal', launchAgent: 'claude', isActive: true }
const POSIX_CLAUDE = "claude '--dangerously-skip-permissions'"
const CMD_CLAUDE = 'claude "--dangerously-skip-permissions"'
// main today: a local POSIX host hands the provider the settings shell untrimmed.
export const ZSH = { shellOverride: '  /bin/zsh  ', terminalWindowsWslDistro: null }
// main today: the host lane sends no shell over SSH, from any OS.
const NO_SHELL = {}
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
export const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
// main today: a \\wsl$ cwd names a distro under a Windows shell; the daemon then runs wsl.exe.
export const CMD_IN_WSL = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: 'Ubuntu' }
const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
export const CMD = { terminalWindowsShell: 'cmd.exe' }
const GLOBAL_WSL = { ...CMD, localWindowsRuntimeDefault: WSL_UBUNTU }
// A saved default argument with an apostrophe: the byte that tells POSIX and PowerShell quoting apart.
const BOB_ARGS = {
  agentDefaultArgs: { claude: `--dangerously-skip-permissions --name "Bob's box"` }
}
const BOB_POSIX = `${POSIX_CLAUDE} '--name' 'Bob'"'"'s box'`
const BOB_PS = `${POSIX_CLAUDE} '--name' 'Bob''s box'`
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"

/** Row 3: agent.launch with no prompt; `command` + shell are what the provider gets. */
function aiButton(
  name: string,
  os: NodeJS.Platform,
  workspace: LaunchWorkspace,
  provider: HostProviderFacts,
  settings?: Record<string, unknown>
): HostLaunchCase {
  return {
    name,
    row: '3',
    os,
    workspace,
    ...(settings ? { settings } : {}),
    call: agentLaunch({ launchSource: aiButtonSource(workspace) }),
    provider,
    telemetry: { ...TASK_PAGE, launch_source: aiButtonSource(workspace) },
    phone: AGENT_PHONE
  }
}
const ssh = { connectionId: 'ssh-1' }

export const HOST_LAUNCH_CASES: HostLaunchCase[] = [
  aiButton('macOS repo', 'darwin', repo(POSIX_PATH), { command: POSIX_CLAUDE, ...ZSH }),
  aiButton('macOS folder', 'darwin', folder(POSIX_PATH), { command: POSIX_CLAUDE, ...ZSH }),
  aiButton('Windows C: repo, default PowerShell', 'win32', repo(WIN_PATH), {
    command: POSIX_CLAUDE,
    ...PWSH
  }),
  aiButton('Windows C: folder, default PowerShell', 'win32', folder(WIN_PATH), {
    command: POSIX_CLAUDE,
    ...PWSH
  }),
  aiButton(
    'Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    { command: CMD_CLAUDE, ...CMD_EXE },
    CMD
  ),
  // main today: the repo planner ignores the \\wsl$ path and quotes for cmd.exe; the shell is WSL.
  aiButton(
    'Windows wsl$ repo, no saved runtime, cmd.exe',
    'win32',
    repo(WSL_PATH),
    { command: CMD_CLAUDE, ...CMD_IN_WSL },
    CMD
  ),
  aiButton(
    'Windows wsl$ folder, cmd.exe',
    'win32',
    folder(WSL_PATH),
    { command: POSIX_CLAUDE, ...CMD_IN_WSL },
    CMD
  ),
  aiButton(
    'Windows C: repo, project WSL',
    'win32',
    repo(WIN_PATH, { projectRuntime: WSL_UBUNTU }),
    { command: POSIX_CLAUDE, ...WSL_EXE },
    CMD
  ),
  aiButton(
    'Windows wsl$ repo, project Windows host',
    'win32',
    repo(WSL_PATH, { projectRuntime: { kind: 'windows-host' } }),
    { command: CMD_CLAUDE, ...CMD_IN_WSL },
    CMD
  ),
  aiButton(
    'Windows C: repo, global default WSL',
    'win32',
    repo(WIN_PATH),
    { command: POSIX_CLAUDE, ...WSL_EXE },
    GLOBAL_WSL
  ),
  // main today: a folder reads only its path, never the global WSL default.
  aiButton(
    'Windows C: folder, global default WSL',
    'win32',
    folder(WIN_PATH),
    { command: CMD_CLAUDE, ...CMD_EXE },
    GLOBAL_WSL
  ),
  aiButton('macOS host, SSH repo', 'darwin', repo(POSIX_PATH, ssh), {
    command: POSIX_CLAUDE,
    ...NO_SHELL
  }),
  aiButton(
    'Windows host, SSH repo, cmd.exe',
    'win32',
    repo(POSIX_PATH, ssh),
    { command: POSIX_CLAUDE, ...NO_SHELL },
    CMD
  ),
  // A folder over SSH quotes for its own path: POSIX here, PowerShell for a Windows path.
  aiButton(
    'Linux host, SSH folder',
    'linux',
    folder(POSIX_PATH, ssh),
    { command: BOB_POSIX, ...NO_SHELL },
    BOB_ARGS
  ),
  aiButton(
    'Linux host, SSH Windows-path folder',
    'linux',
    folder(WIN_PATH, ssh),
    { command: BOB_PS, ...NO_SHELL },
    BOB_ARGS
  ),
  {
    // The AI buttons never send a prompt; the window pastes it once the agent is ready.
    // main today: with no prompt on the command, the host does not wait for the shell.
    ...aiButton('macOS repo, codex', 'darwin', repo(POSIX_PATH), { command: CODEX, ...ZSH }),
    call: agentLaunch({ startupAgent: 'codex' }),
    telemetry: { ...TASK_PAGE, agent_kind: 'codex' },
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  {
    // A remote Windows path quotes PowerShell-style (the doubled apostrophe), whatever the host.
    name: 'mobile quick command, Linux host, SSH Windows-path repo, codex prompt',
    row: '10',
    os: 'linux',
    workspace: repo(WIN_PATH, ssh),
    call: mobileQuickCommand("fix Bob's branch"),
    provider: { command: `${CODEX} 'fix Bob''s branch'`, startupCommandDelivery: 'shell-ready' },
    telemetry: QUICK_COMMAND,
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  {
    name: 'mobile quick command, macOS repo, codex prompt waits for the shell',
    row: '10',
    os: 'darwin',
    workspace: repo(POSIX_PATH),
    call: mobileQuickCommand("fix Bob's branch"),
    provider: {
      command: `${CODEX} 'fix Bob'"'"'s branch'`,
      startupCommandDelivery: 'shell-ready',
      ...ZSH
    },
    telemetry: QUICK_COMMAND,
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  ...[repo(POSIX_PATH), folder(POSIX_PATH), repo(POSIX_PATH, { connectionId: 'ssh-1' })].map(
    (workspace): HostLaunchCase => ({
      name: `orchestration worker, Linux ${workspace.kind}${workspace.connectionId ? ' over SSH' : ''}`,
      row: '10',
      os: 'linux',
      workspace,
      call: worker,
      provider: { command: POSIX_CLAUDE, ...(workspace.connectionId ? NO_SHELL : ZSH) },
      telemetry: { ...TASK_PAGE, launch_source: 'orchestration' },
      phone: { title: 'worker-task-1', launchAgent: 'claude', isActive: true }
    })
  )
]

const HOST_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_TERMINAL_HANDLE'
]
const FOLDER_ENV_KEYS = ['ORCA_WORKSPACE_ID', 'ORCA_PROJECT_GROUP_ID', 'ORCA_WORKSPACE_ROOT']

/** What main hands the provider for a host-lane case. */
export function expectedHostProvider(c: HostLaunchCase): Record<string, unknown> {
  return {
    cwd: c.workspace.path.replaceAll('\\', '/'),
    cols: 120,
    rows: 40,
    commandDelivery: 'provider',
    hidden: true,
    env: {},
    ...c.provider,
    // main today: the host lane stamps ORCA_WORKSPACE_ID on folders only.
    orcaEnv: c.workspace.kind === 'folder' ? [...FOLDER_ENV_KEYS, ...HOST_ENV_KEYS] : HOST_ENV_KEYS
  }
}
