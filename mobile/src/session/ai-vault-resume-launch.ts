// Mobile vault resume rides the host-owned resume-via-arm (U7): the client echoes
// the discovered session identity and the host runs a fresh scan, re-validates it,
// and assembles the command itself. The client-assembled path below survives only
// as the explicit "Launch with current settings" fallback when the host reports
// invalid_launch_snapshot.
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from '../../../src/shared/ai-vault-resume-command'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import { isResumableTuiAgent } from '../../../src/shared/agent-session-resume'
import type { SleepingAgentLaunchConfig } from '../../../src/shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../../src/shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../src/shared/tui-agent-launch-defaults'
import { normalizeAiVaultResumeFilePath } from '../../../src/shared/ai-vault-resume-path'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { parseWslUncPath } from '../../../src/shared/wsl-paths'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/windows-terminal-shell'
import type { AgentLaunchVaultResumeEntry } from '../../../src/shared/agent-launch-spawn-request'
import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'
import {
  readMobileVaultResumeCreateOutcome,
  type MobileResumeOutcome
} from './ai-vault-resume-outcome'
import type { MobileAiVaultResumeTargetStatus } from '../agent-history/agent-history-resume-target'

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
    resumeFilePath: normalizeAiVaultResumeFilePath(args.session.filePath, args.hostPlatform),
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
  envToDelete?: string[]
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
  const resumeFilePath = normalizeAiVaultResumeFilePath(args.session.filePath, args.hostPlatform)
  if (isResumableTuiAgent(args.session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: { key: 'session_id', id: args.session.sessionId },
      cmdOverrides,
      platform: args.hostPlatform,
      shell,
      agentArgs: resolveTuiAgentLaunchArgs(args.session.agent, args.settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(args.session.agent, args.settings?.agentDefaultEnv),
      ...(args.session.agent === 'omp' && resumeFilePath
        ? { ompResumeFilePath: resumeFilePath }
        : {})
    })
    if (startupPlan) {
      return {
        command:
          args.session.agent === 'omp'
            ? buildMobileAiVaultResumeCommand({
                session: {
                  ...args.session,
                  ...(resumeFilePath ? { filePath: resumeFilePath } : {})
                },
                hostPlatform: args.hostPlatform,
                hostTerminalWindowsShell: args.hostTerminalWindowsShell,
                commandOverride: startupPlan.launchConfig.agentCommand
              })
            : buildAiVaultResumeShellCommand({
                resumeCommand: startupPlan.launchCommand,
                cwd: args.session.cwd,
                platform: args.hostPlatform,
                codexHome,
                shell
              }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        // Why: the resume command is typed into the created pane, so the bare
        // real-home override must strip Codex homes at pane spawn like desktop.
        ...realHomeCodexResumeEnvDeletion(args.session),
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
    }),
    ...realHomeCodexResumeEnvDeletion(args.session)
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
      ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {}),
      activate: false,
      select: true,
      navigation: 'caller'
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

// Echoes the host listing's own discovered identity for the resume-via-arm.
// filePath is trusted desktop-IPC only; mobile OMITS it and the host re-derives it
// from its own fresh scan, so it can never become a client-supplied spawn input.
export function buildMobileAiVaultResumeEntry(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId' | 'resumeLocator'>
): AgentLaunchVaultResumeEntry {
  return {
    executionHostId: session.executionHostId,
    agent: session.agent,
    sessionId: session.sessionId,
    ...(session.resumeLocator ? { resumeLocator: session.resumeLocator } : {})
  }
}

// Host-owned vault resume: send the echoed identity through the agentLaunch arm on
// createTerminal. The host assembles + delivers the resume command as the terminal
// startup, so there is NO client terminal.send and no launch receipt on success.
export async function resumeAiVaultSessionViaHostArm(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  args: { entry: AgentLaunchVaultResumeEntry; clientMutationId?: string }
): Promise<MobileResumeOutcome> {
  const created = await client.sendRequest(
    'session.tabs.createTerminal',
    {
      worktree: `id:${worktreeId}`,
      agentLaunch: { vaultResume: { operation: 'resume', entry: args.entry } },
      ...(args.clientMutationId ? { clientMutationId: args.clientMutationId } : {})
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!created.ok) {
    throw new Error(created.error?.message || 'Failed to resume session')
  }
  return readMobileVaultResumeCreateOutcome(created.result)
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
