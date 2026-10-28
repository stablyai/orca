import { POSIX_PATH, WIN_PATH } from '../../../shared/launch-parity-window-cases.test-fixture'
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

// Paired new-tab requests carry intent; host planning determines command and environment.
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

// Preserve host prompt-carry behavior for long prompts and stdin-prompt agents.
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
  ...PAIRED_TAB_CASES.map(([name, params, provider]): HostLaunchCase => ({
    name: `paired new tab: ${name}`,
    row: '7',
    os: 'linux',
    workspace: repo(PAIRED_TAB_PATH),
    call: rpc('terminal.createAgentSession', params),
    provider: { ...provider, ...ZSH },
    // The paired client's launch_source is not forwarded to the host.
    telemetry: {
      agent_kind: params.agent === 'claude' ? 'claude-code' : String(params.agent),
      launch_source: 'unknown',
      request_kind: 'new'
    },
    phone: { title: 'Terminal', launchAgent: String(params.agent), isActive: false }
  })),
  {
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
  // Seeded model-pick commands must survive host validation and pane spawning.
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
    // The pane's launch_source is not forwarded to the host.
    telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' },
    phone: { title: 'Terminal', launchAgent: 'opencode', isActive: false }
  }))
]
