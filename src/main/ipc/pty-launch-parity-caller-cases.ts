// Test-only: host-lane parity cases whose caller already built the launch (rows 5r and 8, run
// verbatim) or asks createAgentSession for it (row 4, OpenCode with a model pick).
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import { HOST_LEAF_ID, HOST_TAB_ID } from './pty-launch-parity-fixture'
import {
  AGENT_PHONE,
  CMD,
  CMD_EXE,
  CMD_IN_WSL,
  folder,
  repo,
  rulesFor,
  ZSH,
  type HostLaunchCall,
  type HostLaunchCase
} from './pty-launch-parity-host-cases'

// A window-built launch quoted for a Windows cmd.exe client; the host must not re-quote it.
export const CLIENT_COMMAND = 'claude "--dangerously-skip-permissions" "run remotely"'
const callerLaunch = (extra: Record<string, unknown>): HostLaunchCall => ({
  kind: 'create',
  options: {
    command: CLIENT_COMMAND,
    env: { CUSTOM_FLAG: '1', ORCA_PANE_KEY: 'stale-tab:stale-leaf' },
    launchConfig: {
      agentCommand: 'claude',
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    },
    launchAgent: 'claude',
    ...extra
  }
})
export const OPENCODE_MODEL = 'opencode/fledge-alpha-free'
// spawnIpcPty's terminal.createAgentSession params for an OpenCode pane with a model pick.
export const openCodeSession: HostLaunchCall = {
  kind: 'agent-session',
  request: {
    agent: 'opencode',
    launchPreferences: { model: OPENCODE_MODEL },
    placement: { tabId: HOST_TAB_ID, leafId: HOST_LEAF_ID },
    presentation: 'background'
  }
}

export const CALLER_LAUNCH_CASES: HostLaunchCase[] = [
  {
    // terminal.create from runtime-agent-background-create.ts (legacy paired automation).
    name: 'legacy paired automation, verbatim on a Linux host',
    row: '5r',
    rules: [],
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: callerLaunch({
      launchToken: 'launch-token-1',
      title: 'Nightly triage',
      focus: false,
      rendererBacked: false,
      activate: false,
      presentation: 'background',
      tabId: HOST_TAB_ID,
      leafId: HOST_LEAF_ID
    }),
    provider: { command: CLIENT_COMMAND, ...ZSH },
    telemetry: null,
    phone: { title: 'Nightly triage', launchAgent: 'claude', isActive: false }
  },
  {
    // runtime-local-worktree-terminal-startup.ts for a paired worktree.create (telemetry dropped).
    name: 'paired worktree.create startup, verbatim',
    row: '8',
    rules: [],
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: callerLaunch({ startupCommandDelivery: 'shell-ready', surfaceOwner: false }),
    provider: { command: CLIENT_COMMAND, startupCommandDelivery: 'shell-ready', ...ZSH },
    telemetry: null,
    phone: AGENT_PHONE
  },
  {
    // worktree-remote.ts spawnLocalStartupAndSetupTerminals: the local create keeps telemetry.
    name: 'local-git worktrees:create startup, verbatim',
    row: '8',
    rules: [],
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: callerLaunch({
      surfaceOwner: false,
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    }),
    provider: { command: CLIENT_COMMAND, ...ZSH },
    telemetry: {
      agent_kind: 'claude-code',
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    },
    phone: AGENT_PHONE
  },
  ...(
    [
      ['macOS repo', 'darwin', repo(POSIX_PATH), "opencode '--standalone'", ZSH],
      ['macOS folder', 'darwin', folder(POSIX_PATH), "opencode '--standalone'", ZSH],
      ['Windows C: repo', 'win32', repo(WIN_PATH), 'opencode "--standalone"', CMD_EXE],
      [
        'Windows wsl$ repo, no saved runtime',
        'win32',
        repo(WSL_PATH),
        'opencode "--standalone"',
        CMD_IN_WSL
      ]
    ] as const
  ).map(([where, os, workspace, command, shell]): HostLaunchCase => ({
    name: `OpenCode model pick, ${where}`,
    row: '4',
    rules: rulesFor(workspace),
    os,
    workspace,
    settings: CMD,
    call: openCodeSession,
    provider: { command, ...shell },
    // main today: the pane's own launch_source never reaches the host.
    telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' },
    phone: { title: 'Terminal', launchAgent: 'opencode', isActive: false }
  }))
]
