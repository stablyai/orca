import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from '../../../src/shared/ai-vault-types'
import { isResumableTuiAgent } from '../../../src/shared/agent-session-resume'
import type { SleepingAgentLaunchConfig } from '../../../src/shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../../src/shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../src/shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../src/shared/types'
import { parseWslUncPath } from '../../../src/shared/wsl-paths'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/windows-terminal-shell'
import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'
import type { MobileAiVaultResumeTargetStatus } from '../agent-history/agent-history-resume-target'

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
])

export function buildMobileAiVaultResumeCommand(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'> &
    Partial<Pick<AiVaultSession, 'filePath'>>
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell?: string | null
  commandOverride?: string | null
}): string {
  // Why: this command is typed into the freshly created host terminal, so on
  // Windows it must match the host's live shell instead of the phone platform.
  const shell =
    args.hostPlatform === 'win32'
      ? resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      : undefined
  return buildAiVaultResumeCommand({
    agent: args.session.agent,
    sessionId: args.session.sessionId,
    // Why: OMP resumes by absolute transcript path (custom OMP dir / WSL-store
    // sessions miss on an id lookup), so mobile forwards it like desktop does.
    resumeFilePath: args.session.filePath,
    cwd: args.session.cwd,
    platform: args.hostPlatform,
    commandOverride: args.commandOverride,
    codexHome: getMobileAiVaultResumeCodexHome(args.session.codexHome, args.hostPlatform),
    shell
  })
}

export type MobileAiVaultResumeSettings = {
  agentCmdOverrides?: Partial<Record<TuiAgent, string | null>>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
}

export type MobileAiVaultResumeLaunch = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
}

export function buildMobileAiVaultResumeLaunch(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome'> &
    Partial<Pick<AiVaultSession, 'filePath'>>
  hostPlatform: NodeJS.Platform
  hostTerminalWindowsShell?: string | null
  settings?: MobileAiVaultResumeSettings | null
}): MobileAiVaultResumeLaunch {
  const shell =
    args.hostPlatform === 'win32'
      ? resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      : undefined
  const codexHome = getMobileAiVaultResumeCodexHome(args.session.codexHome, args.hostPlatform)
  const cmdOverrides = normalizeMobileAiVaultResumeCommandOverrides(
    args.settings?.agentCmdOverrides
  )
  const commandOverride = cmdOverrides[args.session.agent] ?? null
  if (isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: { key: 'session_id', id: args.session.sessionId },
      cmdOverrides,
      platform: args.hostPlatform,
      shell,
      agentArgs: resolveTuiAgentLaunchArgs(args.session.agent, args.settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(args.session.agent, args.settings?.agentDefaultEnv)
    })
    if (startupPlan) {
      return {
        command: buildAiVaultResumeShellCommand({
          resumeCommand: startupPlan.launchCommand,
          cwd: args.session.cwd,
          platform: args.hostPlatform,
          codexHome,
          shell
        }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        launchConfig: startupPlan.launchConfig,
        launchAgent: startupPlan.agent
      }
    }
  }
  return {
    command: buildMobileAiVaultResumeCommand({
      session: args.session,
      hostPlatform: args.hostPlatform,
      hostTerminalWindowsShell: args.hostTerminalWindowsShell,
      commandOverride
    })
  }
}

function normalizeMobileAiVaultResumeCommandOverrides(
  overrides: Partial<Record<TuiAgent, string | null>> | null | undefined
): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!overrides) {
    return normalized
  }
  for (const [agent, command] of Object.entries(overrides) as [TuiAgent, string | null][]) {
    if (typeof command === 'string' && command.trim()) {
      normalized[agent] = command
    }
  }
  return normalized
}

// Why: without an explicit timeout, a socket drop mid-resume parks the request
// on the reconnect waiter for the full reconnect budget, pinning the spinner.
export const RESUME_RPC_TIMEOUT_MS = 30_000

export async function resumeAiVaultSessionInTerminal(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  launch: MobileAiVaultResumeLaunch & { clientMutationId?: string }
): Promise<MobileReviewTerminalTab> {
  const created = await client.sendRequest(
    'session.tabs.createTerminal',
    {
      worktree: `id:${worktreeId}`,
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {})
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to create terminal')
  }
  const terminalTab = readMobileReviewCreatedTerminal(created.result)
  if (!terminalTab) {
    throw new Error('Created terminal response was invalid')
  }
  const sent = await client.sendRequest(
    'terminal.send',
    {
      terminal: terminalTab.terminal,
      text: launch.command,
      enter: true
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!sent.ok) {
    throw new Error(sent.error?.message || 'Failed to send resume command')
  }
  if (!readMobileReviewTerminalSendAccepted(sent.result)) {
    throw new Error('Terminal input is locked')
  }
  return terminalTab
}

export type MobileAiVaultResumeMutationRegistry = {
  claim(sessionId: string): string
  releaseOnSuccess(sessionId: string): void
}

// Why: a retry after a failed/interrupted resume must reuse the same
// idempotency key so the host dedups the create, while a resume after success
// mints a fresh key so the user can intentionally fork the session.
export function createMobileAiVaultResumeMutationRegistry(
  mintId: (sessionId: string) => string
): MobileAiVaultResumeMutationRegistry {
  const bySessionId = new Map<string, string>()
  return {
    claim(sessionId: string): string {
      const existing = bySessionId.get(sessionId)
      if (existing) {
        return existing
      }
      const minted = mintId(sessionId)
      bySessionId.set(sessionId, minted)
      return minted
    },
    releaseOnSuccess(sessionId: string): void {
      bySessionId.delete(sessionId)
    }
  }
}

export function readMobileRuntimeHostPlatform(statusResult: unknown): NodeJS.Platform | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const hostPlatform = (statusResult as { hostPlatform?: unknown }).hostPlatform
  return typeof hostPlatform === 'string' && NODE_PLATFORMS.has(hostPlatform as NodeJS.Platform)
    ? (hostPlatform as NodeJS.Platform)
    : null
}

export function readMobileRuntimeTerminalWindowsShell(statusResult: unknown): string | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const shell = (statusResult as { terminalWindowsShell?: unknown }).terminalWindowsShell
  return typeof shell === 'string' && shell.trim().length > 0 ? shell : null
}

export function resolveMobileAiVaultResumePlatform(
  targetStatus: MobileAiVaultResumeTargetStatus,
  hostPlatform: NodeJS.Platform | null,
  workspacePath?: string | null,
  terminalPlatform?: NodeJS.Platform | null
): NodeJS.Platform | null {
  if (targetStatus === 'ssh') {
    // Why: desktop builds SSH resume commands for the remote POSIX execution
    // host instead of the phone or local desktop platform.
    return 'linux'
  }
  if (targetStatus === 'local') {
    if (terminalPlatform === 'linux' && hostPlatform === 'win32') {
      // Why: Windows-hosted WSL project terminals run a POSIX shell even when
      // the visible workspace path is a normal Windows path.
      return 'linux'
    }
    if (workspacePath && parseWslUncPath(workspacePath)) {
      // Why: a WSL UNC workspace on a Windows host runs in a Linux shell.
      return 'linux'
    }
    return hostPlatform
  }
  return null
}

function getMobileAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}
