import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  getAiVaultAgentProviderSession,
  realHomeCodexResumeEnvDeletion
} from '../../../src/shared/ai-vault-resume-command'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../../src/shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../../src/shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../src/shared/tui-agent-launch-defaults'
import { normalizeAiVaultResumeFilePath } from '../../../src/shared/ai-vault-resume-path'
import type { TuiAgent } from '../../../src/shared/types'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/windows-terminal-shell'
import type { RpcClient } from '../transport/rpc-client'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  type MobileReviewTerminalTab
} from './mobile-diff-review-rpc'
import { tryHostAuthorityAiVaultResume } from './ai-vault-host-authority-resume'
import { normalizeMobileAiVaultCodexHome } from './ai-vault-resume-platform'
import { applyMobileAiVaultResumeTitle } from './ai-vault-resume-title'
export {
  MOBILE_AI_VAULT_HOST_AUTHORITY_RESUME_CAPABILITY,
  readMobileRuntimeCapabilities
} from './ai-vault-host-authority-resume'
export {
  readMobileRuntimeHostPlatform,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform
} from './ai-vault-resume-platform'

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
    codexHome: normalizeMobileAiVaultCodexHome(args.session.codexHome, args.hostPlatform),
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
  providerSession?: AgentProviderSessionMetadata
  startupCwd?: string
  hostAuthorityEligible?: boolean
  resumeTitle?: string
}

type MobileAiVaultResumeLaunchArgs = {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'cwd' | 'codexHome' | 'title'> &
    Partial<Pick<AiVaultSession, 'filePath'>>
  hostPlatform: NodeJS.Platform
  runtimeHostPlatform?: NodeJS.Platform | null
  hostTerminalWindowsShell?: string | null
  settings?: MobileAiVaultResumeSettings | null
}

export function buildMobileAiVaultResumeLaunch(
  args: MobileAiVaultResumeLaunchArgs
): MobileAiVaultResumeLaunch {
  const shell =
    args.hostPlatform === 'win32'
      ? resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      : undefined
  const codexHome = normalizeMobileAiVaultCodexHome(args.session.codexHome, args.hostPlatform)
  const cmdOverrides = normalizeMobileAiVaultResumeCommandOverrides(
    args.settings?.agentCmdOverrides
  )
  const commandOverride = cmdOverrides[args.session.agent] ?? null
  const resumeTitle = args.session.title.trim() || undefined
  const hostTranscriptPath = args.session.filePath?.trim() || undefined
  const resumeFilePath = normalizeAiVaultResumeFilePath(args.session.filePath, args.hostPlatform)
  if (isResumableTuiAgent(args.session.agent)) {
    const baseProviderSession = getAiVaultAgentProviderSession({
      agent: args.session.agent,
      sessionId: args.session.sessionId,
      filePath: hostTranscriptPath
    })
    const providerSession: AgentProviderSessionMetadata | null =
      baseProviderSession && hostTranscriptPath
        ? { ...baseProviderSession, transcriptPath: hostTranscriptPath }
        : baseProviderSession
    if (!providerSession) {
      return buildLegacyMobileAiVaultResumeLaunch(args, commandOverride)
    }
    const executionProviderSession =
      resumeFilePath && resumeFilePath !== hostTranscriptPath
        ? { ...providerSession, transcriptPath: resumeFilePath }
        : providerSession
    const startupPlan = buildAgentResumeStartupPlan({
      agent: args.session.agent,
      providerSession: executionProviderSession,
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
        launchAgent: startupPlan.agent,
        providerSession,
        ...(args.session.cwd?.trim() ? { startupCwd: args.session.cwd.trim() } : {}),
        // Why: Windows-hosted WSL still needs execution-owner Codex/Pi home provenance,
        // while an unknown runtime platform can safely let host authority reject before
        // side effects and fall back to the proven legacy command path.
        hostAuthorityEligible:
          args.runtimeHostPlatform == null || args.runtimeHostPlatform === args.hostPlatform,
        ...(resumeTitle ? { resumeTitle } : {})
      }
    }
  }
  return buildLegacyMobileAiVaultResumeLaunch(args, commandOverride)
}

function buildLegacyMobileAiVaultResumeLaunch(
  args: MobileAiVaultResumeLaunchArgs,
  commandOverride: string | null
): MobileAiVaultResumeLaunch {
  return {
    command: buildMobileAiVaultResumeCommand({
      session: args.session,
      hostPlatform: args.hostPlatform,
      hostTerminalWindowsShell: args.hostTerminalWindowsShell,
      commandOverride
    }),
    ...realHomeCodexResumeEnvDeletion(args.session),
    ...(args.session.title.trim() ? { resumeTitle: args.session.title.trim() } : {})
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
  launch: MobileAiVaultResumeLaunch & { clientMutationId?: string },
  options: { hostCapabilities?: readonly string[] } = {}
): Promise<MobileReviewTerminalTab> {
  const hostAuthorityResume = await tryHostAuthorityAiVaultResume(
    client,
    worktreeId,
    launch,
    options.hostCapabilities
  )
  if (hostAuthorityResume) {
    return hostAuthorityResume.created
      ? await applyMobileAiVaultResumeTitle(
          client,
          hostAuthorityResume.terminal,
          launch.resumeTitle
        )
      : hostAuthorityResume.terminal
  }
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
  return applyMobileAiVaultResumeTitle(client, terminalTab, launch.resumeTitle)
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
