// Test-only: host-lane parity cases whose caller already built the launch (row 8, run verbatim),
// or sends a paired host its intent (row 7) or a model pick (row 4).
import { POSIX_PATH, WIN_PATH } from '../../shared/launch-parity-window-cases.test-fixture'
import {
  AGENT_PHONE,
  CMD,
  CMD_EXE,
  HOST_LEAF_ID,
  HOST_TAB_ID,
  repo,
  ZSH,
  type HostLaunchCall,
  type HostLaunchCase,
  type HostProviderFacts
} from './pty-launch-parity-host.test-cases'

// A window-built codex startup quoted for a Windows cmd.exe client; the host must not re-quote it.
const CLIENT_CODEX = 'codex "--dangerously-bypass-approvals-and-sandbox"'
const CALLER_ENV = { CUSTOM_FLAG: '1' }
const NEW_WORKSPACE = {
  agent_kind: 'codex',
  launch_source: 'new_workspace_composer',
  request_kind: 'new'
} as const
export const OPENCODE_MODEL = 'opencode/fledge-alpha-free'
const rpc = (
  method: 'terminal.create' | 'terminal.createAgentSession',
  params: Record<string, unknown>
): HostLaunchCall => ({ kind: 'rpc', method, params })
const POSIX_CLAUDE = "claude '--dangerously-skip-permissions'"
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"

// Row 7: the terminal.createAgentSession params a paired desktop's new tab sends a current host.
// main today: command, env, launchConfig and startupCommandDelivery never reach the host; agentArgs
// is the window's default args.
const PAIRED_TAB_PATH = '/worktree'
const PAIRED_TAB = {
  worktree: `id:repo-1::${PAIRED_TAB_PATH}`,
  viewMode: 'terminal',
  presentation: 'background'
} as const
const PAIRED_TAB_CASES: [string, Record<string, unknown>, HostProviderFacts][] = [
  [
    'claude draft continuation, initial cwd',
    {
      ...PAIRED_TAB,
      agent: 'claude',
      prompt: "review Bob's change",
      promptDelivery: 'draft',
      agentArgs: '--dangerously-skip-permissions',
      startupCwd: `${PAIRED_TAB_PATH}/packages/app`
    },
    {
      command: `${POSIX_CLAUDE} --prefill 'review Bob'"'"'s change'`,
      cwd: `${PAIRED_TAB_PATH}/packages/app`
    }
  ],
  [
    'codex auto-submit',
    {
      ...PAIRED_TAB,
      agent: 'codex',
      prompt: 'fix it',
      promptDelivery: 'auto-submit',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox'
    },
    { command: `${CODEX} 'fix it'`, startupCommandDelivery: 'shell-ready' }
  ]
]

// createAgentSession plans with the host planner. main today types every prompt on the line,
// even one too long for that planner's carry rule, and starts a stdin-prompt agent clean.
const LONG_PROMPT = 'review the change on this branch and list what breaks. '.repeat(10).trim()
const POWERSHELL = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
type PairedPlanCase = {
  name: string
  os: NodeJS.Platform
  agent: string
  prompt: string
  provider: HostProviderFacts
}
const PAIRED_PLAN_CASES: PairedPlanCase[] = [
  {
    name: 'claude long prompt, macOS',
    os: 'darwin',
    agent: 'claude',
    prompt: LONG_PROMPT,
    provider: { command: `${POSIX_CLAUDE} '${LONG_PROMPT}'`, ...ZSH }
  },
  {
    name: 'aider prompt, starts clean',
    os: 'linux',
    agent: 'aider',
    prompt: 'fix it',
    provider: { command: "aider '--yes-always'", ...ZSH }
  },
  {
    name: 'claude prompt, Windows PowerShell',
    os: 'win32',
    agent: 'claude',
    prompt: "Bob's fix",
    provider: { command: `claude '--dangerously-skip-permissions' 'Bob''s fix'`, ...POWERSHELL }
  }
]

export const CALLER_LAUNCH_CASES: HostLaunchCase[] = [
  ...PAIRED_PLAN_CASES.map((c): HostLaunchCase => {
    const path = c.os === 'win32' ? WIN_PATH : PAIRED_TAB_PATH
    return {
      name: `paired agent session: ${c.name}`,
      row: '7',
      os: c.os,
      workspace: repo(path),
      call: rpc('terminal.createAgentSession', {
        ...PAIRED_TAB,
        worktree: `id:repo-1::${path}`,
        agent: c.agent,
        prompt: c.prompt,
        promptDelivery: 'auto-submit'
      }),
      provider: c.provider,
      telemetry: {
        agent_kind: c.agent === 'claude' ? 'claude-code' : c.agent,
        launch_source: 'unknown',
        request_kind: 'new'
      },
      phone: { title: 'Terminal', launchAgent: c.agent, isActive: false }
    }
  }),
  // C1 changes the host planner; these are its only draft (--prefill) and startupCwd-from-intent rows.
  ...PAIRED_TAB_CASES.map(([name, params, provider]): HostLaunchCase => ({
    name: `paired new tab: ${name}`,
    row: '7',
    os: 'linux',
    workspace: repo(PAIRED_TAB_PATH),
    call: rpc('terminal.createAgentSession', params),
    provider: { ...provider, ...ZSH },
    // main today: a paired client's launch_source never reaches the host.
    telemetry: {
      agent_kind: params.agent === 'claude' ? 'claude-code' : String(params.agent),
      launch_source: 'unknown',
      request_kind: 'new'
    },
    phone: { title: 'Terminal', launchAgent: String(params.agent), isActive: false }
  })),
  {
    // C4/C5: worktree-remote.ts spawnLocalStartupAndSetupTerminals runs the caller's command and env
    // without re-quoting them, and keeps telemetry.
    name: 'local-git worktrees:create startup, verbatim',
    row: '8',
    os: 'linux',
    workspace: repo(POSIX_PATH),
    call: {
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
        surfaceOwner: false,
        telemetry: NEW_WORKSPACE
      }
    },
    provider: {
      command: CLIENT_CODEX,
      startupCommandDelivery: 'shell-ready',
      env: CALLER_ENV,
      ...ZSH
    },
    telemetry: NEW_WORKSPACE,
    phone: { ...AGENT_PHONE, launchAgent: 'codex' }
  },
  // C2 keeps model validation on the host while moving the spawn to the pane; the command must survive.
  ...(
    [
      ['macOS repo', 'darwin', POSIX_PATH, "opencode '--standalone'", ZSH],
      ['Windows C: repo', 'win32', WIN_PATH, 'opencode "--standalone"', CMD_EXE]
    ] as const
  ).map(([where, os, path, command, shell]): HostLaunchCase => ({
    name: `OpenCode model pick, ${where}`,
    row: '4',
    os,
    workspace: repo(path),
    settings: CMD,
    // spawnIpcPty's terminal.createAgentSession for a seeded model-pick pane.
    call: rpc('terminal.createAgentSession', {
      worktree: `id:repo-1::${path}`,
      agent: 'opencode',
      launchPreferences: { model: OPENCODE_MODEL },
      startupCwd: path,
      placement: { tabId: HOST_TAB_ID, leafId: HOST_LEAF_ID },
      presentation: 'background',
      // A local Windows ConPTY pane withholds kitty.
      ...(path === WIN_PATH ? {} : { terminalKittyKeyboardProtocol: true })
    }),
    provider: { command, ...shell },
    // main today: the pane's own launch_source never reaches the host.
    telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' },
    phone: { title: 'Terminal', launchAgent: 'opencode', isActive: false }
  }))
]
