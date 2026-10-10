// Test-only: the host-lane launch parity table (rows 3, 4, 5r, 8, 10). Each case is the call a
// host producer makes and the facts main hands the provider, the phone and telemetry for it.
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import type { LaunchWorkspace } from '../../shared/launch-parity-window-request.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import { HOST_LEAF_ID, HOST_TAB_ID } from './pty-launch-parity-fixture'

export type HostLaunchCall =
  | { kind: 'create'; options: TerminalCreateOptions }
  | {
      kind: 'agent-session'
      request: Omit<RuntimeCreateAgentSessionRequest, 'clientOperationId' | 'worktree'>
    }

export type HostProviderFacts = {
  command: string
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  startupCommandDelivery?: 'shell-ready'
}

export type HostLaunchCase = {
  name: string
  /** PLAN-v2 §3 producer row; `rules` names the §4.3 runtime rules the case exercises. */
  row: '3' | '4' | '5r' | '8' | '10'
  rules: readonly string[]
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

// rpc/methods/agent-launch-surfaces.ts createTerminalAgent options for a reserved pane.
const agentLaunch = (extra: Record<string, unknown> = {}): HostLaunchCall => ({
  kind: 'create',
  options: {
    startupAgent: 'claude',
    tabId: HOST_TAB_ID,
    leafId: HOST_LEAF_ID,
    requireFreshPane: true,
    launchSource: 'cli',
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
const CLI = { agent_kind: 'claude-code', launch_source: 'cli', request_kind: 'new' }
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
const REPO_RULES = ['HOST_REPO', 'RUNTIME_ASSEMBLER']
const FOLDER_RULES = ['HOST_FOLDER_PATH', 'RUNTIME_ASSEMBLER']
export const rulesFor = (workspace: LaunchWorkspace): string[] =>
  workspace.kind === 'repo' ? REPO_RULES : FOLDER_RULES

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
    rules: rulesFor(workspace),
    os,
    workspace,
    ...(settings ? { settings } : {}),
    call: agentLaunch(),
    provider,
    telemetry: CLI,
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
  aiButton('Linux host, SSH folder', 'linux', folder(POSIX_PATH, ssh), {
    command: POSIX_CLAUDE,
    ...NO_SHELL
  }),
  {
    // A remote Windows path quotes PowerShell-style (the doubled apostrophe), whatever the host.
    name: 'Linux host, SSH Windows-path repo, codex prompt',
    row: '3',
    rules: REPO_RULES,
    os: 'linux',
    workspace: repo(WIN_PATH, ssh),
    call: agentLaunch({ startupAgent: 'codex', startupPrompt: "fix Bob's branch" }),
    provider: {
      command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob''s branch'",
      startupCommandDelivery: 'shell-ready'
    },
    telemetry: { ...CLI, agent_kind: 'codex' },
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  {
    name: 'macOS repo, codex prompt waits for the shell',
    row: '3',
    rules: REPO_RULES,
    os: 'darwin',
    workspace: repo(POSIX_PATH),
    call: agentLaunch({ startupAgent: 'codex', startupPrompt: "fix Bob's branch" }),
    provider: {
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob'"'"'s branch'`,
      startupCommandDelivery: 'shell-ready',
      ...ZSH
    },
    telemetry: { ...CLI, agent_kind: 'codex' },
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  ...[repo(POSIX_PATH), folder(POSIX_PATH), repo(POSIX_PATH, { connectionId: 'ssh-1' })].map(
    (workspace): HostLaunchCase => ({
      name: `orchestration worker, Linux ${workspace.kind}${workspace.connectionId ? ' over SSH' : ''}`,
      row: '10',
      rules: [],
      os: 'linux',
      workspace,
      call: worker,
      provider: { command: POSIX_CLAUDE, ...(workspace.connectionId ? NO_SHELL : ZSH) },
      telemetry: { ...CLI, launch_source: 'orchestration' },
      phone: { title: 'worker-task-1', launchAgent: 'claude', isActive: true }
    })
  )
]
