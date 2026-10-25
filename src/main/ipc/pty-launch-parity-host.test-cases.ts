import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import type { LaunchWorkspace } from '../../shared/launch-parity-window-request.test-fixture'
import { POSIX_PATH, WSL_PATH } from '../../shared/launch-parity-window-cases.test-fixture'

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
  row: '3' | '4' | '7' | '8' | '10'
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
const worker: HostLaunchCall = {
  kind: 'create',
  options: {
    startupAgent: 'claude',
    launchSource: 'orchestration',
    title: 'worker-task-1',
    surfaceOwner: false
  }
}

export const repo = (path: string): LaunchWorkspace => ({ kind: 'repo', path })
const folder = (path: string): LaunchWorkspace => ({ kind: 'folder', path })
// Mobile replay reserves a pane without moving the host window.
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
// Repo AI actions use task_page; folder review-note actions use notes_send.
const aiButtonSource = (workspace: LaunchWorkspace): string =>
  workspace.kind === 'repo' ? 'task_page' : 'notes_send'
const QUICK_COMMAND = { agent_kind: 'codex', launch_source: 'quick_command', request_kind: 'new' }
export const AGENT_PHONE = { title: 'Terminal', launchAgent: 'claude', isActive: true }
const POSIX_CLAUDE = "claude '--dangerously-skip-permissions'"
export const ZSH = { shellOverride: '/bin/zsh', terminalWindowsWslDistro: null }
export const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
export const CMD = { terminalWindowsShell: 'cmd.exe' }
// Apostrophes distinguish POSIX quoting from PowerShell quoting.
const BOB_ARGS = {
  agentDefaultArgs: { claude: `--dangerously-skip-permissions --name "Bob's box"` }
}
const BOB_POSIX = `${POSIX_CLAUDE} '--name' 'Bob'"'"'s box'`
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"

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
export const HOST_LAUNCH_CASES: HostLaunchCase[] = [
  aiButton('macOS repo', 'darwin', repo(POSIX_PATH), { command: POSIX_CLAUDE, ...ZSH }),
  // A WSL-share repo without saved runtime must quote for Linux and run in its distro.
  aiButton(
    'Windows wsl$ repo, no saved runtime',
    'win32',
    repo(WSL_PATH),
    { command: POSIX_CLAUDE, shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' },
    CMD
  ),
  aiButton(
    'macOS folder, saved default args',
    'darwin',
    folder(POSIX_PATH),
    { command: BOB_POSIX, ...ZSH },
    BOB_ARGS
  ),
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
  ...[repo(POSIX_PATH), folder(POSIX_PATH)].map((workspace): HostLaunchCase => ({
    name: `orchestration worker, Linux ${workspace.kind}`,
    row: '10',
    os: 'linux',
    workspace,
    call: worker,
    provider: { command: POSIX_CLAUDE, ...ZSH },
    telemetry: { ...TASK_PAGE, launch_source: 'orchestration' },
    phone: { title: 'worker-task-1', launchAgent: 'claude', isActive: true }
  }))
]

const HOST_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_TERMINAL_HANDLE'
]
const FOLDER_ENV_KEYS = ['ORCA_WORKSPACE_ID', 'ORCA_PROJECT_GROUP_ID', 'ORCA_WORKSPACE_ROOT']

export function expectedHostProvider(c: HostLaunchCase): Record<string, unknown> {
  // Windows shell metadata is consumed only by Windows main.
  const { terminalWindowsWslDistro, ...provider } = c.provider
  return {
    cwd: c.workspace.path.replaceAll('\\', '/'),
    cols: 120,
    rows: 40,
    commandDelivery: 'provider',
    hidden: true,
    env: {},
    ...provider,
    ...(c.os === 'win32' ? { terminalWindowsWslDistro } : {}),
    orcaEnv:
      c.workspace.kind === 'folder'
        ? [...FOLDER_ENV_KEYS, ...HOST_ENV_KEYS]
        : ['ORCA_WORKSPACE_ID', ...HOST_ENV_KEYS]
  }
}
