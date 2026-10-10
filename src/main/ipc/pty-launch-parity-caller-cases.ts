// Test-only: host-lane parity cases whose caller already built the launch (rows 5r legacy and 8,
// run verbatim), or sends a paired host its intent (rows 5r and 7) or a model pick (row 4).
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import {
  PAIRED_AUTOMATION_CASES,
  PAIRED_AUTOMATION_FROM_WINDOWS,
  PAIRED_TAB_HOST_PARAMS,
  PAIRED_TAB_PATH,
  pairedAgentSessionParams,
  pairedLegacyCreateParams
} from '../../shared/launch-parity-paired-host.test-fixture'
import {
  AGENT_PHONE,
  CMD,
  CMD_EXE,
  CMD_IN_WSL,
  folder,
  HOST_LEAF_ID,
  HOST_TAB_ID,
  repo,
  ZSH,
  type HostLaunchCall,
  type HostLaunchCase,
  type HostProviderFacts
} from './pty-launch-parity-host-cases'

// A window-built codex startup quoted for a Windows cmd.exe client; the host must not re-quote it.
const CLIENT_CODEX = 'codex "--dangerously-bypass-approvals-and-sandbox"'
const CALLER_ENV = { CUSTOM_FLAG: '1' }
const callerStartup = (extra: Record<string, unknown>): HostLaunchCall => ({
  kind: 'create',
  options: {
    command: CLIENT_CODEX,
    env: CALLER_ENV,
    launchConfig: {
      agentCommand: CLIENT_CODEX,
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: CALLER_ENV
    },
    launchAgent: 'codex',
    startupCommandDelivery: 'shell-ready',
    ...extra
  }
})
const CODEX_PHONE = { ...AGENT_PHONE, launchAgent: 'codex' }
const NEW_WORKSPACE = {
  agent_kind: 'codex',
  launch_source: 'new_workspace_composer',
  request_kind: 'new'
}
export const OPENCODE_MODEL = 'opencode/fledge-alpha-free'
const rpc = (
  method: 'terminal.create' | 'terminal.createAgentSession',
  params: Record<string, unknown>
): HostLaunchCall => ({ kind: 'rpc', method, params })
const POSIX_CLAUDE = "claude '--dangerously-skip-permissions'"
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"
const DONT_STOP = `'don'"'"'t stop'`
// What a current host spawns for each intent: it re-plans the command itself.
const PAIRED_AUTOMATION_PROVIDER: Record<string, HostProviderFacts> = {
  claude: { command: `${POSIX_CLAUDE} ${DONT_STOP}` },
  codex: { command: `${CODEX} ${DONT_STOP}`, startupCommandDelivery: 'shell-ready' },
  aider: { command: "aider '--yes-always'" }
}
// main today: a paired client's launch_source never reaches the host.
const unknownSource = (agent: unknown) => ({
  agent_kind: agent === 'claude' ? 'claude-code' : String(agent),
  launch_source: 'unknown',
  request_kind: 'new'
})
const CLAUDE_PREFILL = `${POSIX_CLAUDE} --prefill 'review Bob'"'"'s change'`
const PAIRED_TAB_PROVIDER: Record<string, HostProviderFacts> = {
  'claude draft': { command: CLAUDE_PREFILL },
  'claude draft continuation, initial cwd': {
    command: CLAUDE_PREFILL,
    cwd: `${PAIRED_TAB_PATH}/packages/app`
  },
  'codex auto-submit': { command: `${CODEX} 'fix it'`, startupCommandDelivery: 'shell-ready' },
  'codex auto-submit, caller agentArgs': {
    command: "codex '--model' 'gpt-5' 'fix it'",
    startupCommandDelivery: 'shell-ready'
  }
}

export const CALLER_LAUNCH_CASES: HostLaunchCase[] = [
  {
    // runtime-agent-background-create.ts's legacy terminal.create, as the renderer suite pins it.
    name: 'legacy paired automation from a Windows client, verbatim on a Linux host',
    row: '5r',
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: rpc('terminal.create', pairedLegacyCreateParams(PAIRED_AUTOMATION_FROM_WINDOWS)),
    provider: { command: `${POSIX_CLAUDE} 'don''t stop'`, ...ZSH },
    telemetry: null,
    phone: { title: 'Nightly audit run 3', launchAgent: 'claude', isActive: false }
  },
  ...PAIRED_AUTOMATION_CASES.filter((c) => c.client === 'linux' && c.keyboard).map(
    (c): HostLaunchCase => ({
      name: `paired automation, current host: ${c.name}`,
      row: '5r',
      os: 'linux',
      workspace: repo(POSIX_PATH),
      call: rpc('terminal.createAgentSession', pairedAgentSessionParams(c)),
      provider: { ...PAIRED_AUTOMATION_PROVIDER[c.agent], ...ZSH },
      telemetry: unknownSource(c.agent),
      phone: { title: 'Terminal', launchAgent: c.agent, isActive: false }
    })
  ),
  ...Object.entries(PAIRED_TAB_HOST_PARAMS).map(([name, params]): HostLaunchCase => ({
    name: `paired new tab, current host: ${name}`,
    row: '7',
    os: 'linux',
    workspace: repo(PAIRED_TAB_PATH),
    call: rpc('terminal.createAgentSession', params),
    provider: { ...PAIRED_TAB_PROVIDER[name], ...ZSH },
    telemetry: unknownSource(params.agent),
    phone: { title: 'Terminal', launchAgent: String(params.agent), isActive: false }
  })),
  {
    // runtime-local-worktree-terminal-startup.ts for a paired worktree.create (always activated);
    // the window already dropped telemetry (worktree-create-payload-startup.test.ts).
    name: 'paired worktree.create startup, verbatim',
    row: '8',
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: callerStartup({}),
    provider: {
      command: CLIENT_CODEX,
      startupCommandDelivery: 'shell-ready',
      env: CALLER_ENV,
      ...ZSH
    },
    telemetry: null,
    phone: CODEX_PHONE
  },
  {
    // worktree-remote.ts spawnLocalStartupAndSetupTerminals: the local create keeps telemetry.
    name: 'local-git worktrees:create startup, verbatim',
    row: '8',
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: callerStartup({ surfaceOwner: false, telemetry: NEW_WORKSPACE }),
    provider: {
      command: CLIENT_CODEX,
      startupCommandDelivery: 'shell-ready',
      env: CALLER_ENV,
      ...ZSH
    },
    telemetry: NEW_WORKSPACE,
    phone: CODEX_PHONE
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
    os,
    workspace,
    settings: CMD,
    // spawnIpcPty's terminal.createAgentSession for a seeded model-pick pane (ipc-pty-opencode-model.test.ts).
    call: rpc('terminal.createAgentSession', {
      worktree: `id:${workspace.kind === 'repo' ? `repo-1::${workspace.path}` : 'folder:fw-1'}`,
      agent: 'opencode',
      launchPreferences: { model: OPENCODE_MODEL },
      startupCwd: workspace.path,
      placement: { tabId: HOST_TAB_ID, leafId: HOST_LEAF_ID },
      presentation: 'background',
      terminalKittyKeyboardProtocol: true
    }),
    provider: { command, ...shell },
    // main today: the pane's own launch_source never reaches the host.
    telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' },
    phone: { title: 'Terminal', launchAgent: 'opencode', isActive: false }
  }))
]
