import type {
  AgentProgramBlockReason,
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../src/shared/agent-session/lifecycle/agent-session-resume'
import {
  buildAiVaultLocalResumeStartup,
  buildAiVaultTypedResumeStartup,
  type AiVaultResumeCommandSession,
  type AiVaultResumeLaunchSettings
} from '../../../src/shared/ai-vault/resume/ai-vault-resume-startup'
import {
  buildAiVaultRemoteResumeStartup,
  resolveAiVaultResumeHostShell
} from '../../../src/shared/ai-vault/resume/ai-vault-resume-host-startup'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { parseWslUncPath } from '../../../src/shared/file-access/wsl-paths'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/shell/launch/windows-terminal-shell'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import {
  reviewTerminalCreateRun,
  reviewTerminalSendRun
} from '../source-control/review/terminal-delivery/mobile-review-terminal-operations'
import type { MobileReviewTerminalTab } from '../source-control/review/terminal-delivery/review-terminal-reply-schema'
import type { AiVaultResumeTargetStatus } from '../../../src/shared/ai-vault/resume/ai-vault-resume-target'
import { GENERATED_AGENT_LAUNCH_ENV } from '../../../src/shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  QODER_OWNED_TERMINAL_CREATE_CAPABILITY,
  SESSION_HISTORY_TERMINAL_CREATE_CAPABILITY
} from '../../../src/shared/agent-launch/startup/qoder-terminal-create-capability'
import { agentHistoryHostStatusSchema } from './agent-history-reply-schema'
import { readMobileRuntimeHostPlatform } from '../transport/connection/mobile-runtime-host-platform'
import { translate } from '../i18n/mobile-i18n'

export function readMobileAiVaultResumeHost(statusResult: unknown) {
  const status = agentHistoryHostStatusSchema.safeParse(statusResult)
  return {
    platform: readMobileRuntimeHostPlatform(statusResult),
    capabilities: status.success ? status.data.capabilities : undefined
  }
}

export type MobileAiVaultResumeLaunch = {
  command: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  resumeProviderSession?: AgentProviderSessionMetadata
}

export function buildMobileAiVaultResumeLaunch(args: {
  session: AiVaultResumeCommandSession
  workspacePlatform: NodeJS.Platform
  hostTerminalWindowsShell?: string | null
  hostCapabilities?: readonly string[]
  settings?: AiVaultResumeLaunchSettings | null
}): MobileAiVaultResumeLaunch {
  const commandOverride = args.settings?.agentCmdOverrides?.[args.session.agent]
  const hostOwned = args.hostCapabilities?.includes(SESSION_HISTORY_TERMINAL_CREATE_CAPABILITY)
  const buildResume = hostOwned ? buildAiVaultLocalResumeStartup : buildAiVaultTypedResumeStartup
  const startup =
    (hostOwned ? null : buildAiVaultRemoteResumeStartup(args.session, commandOverride)) ??
    buildResume({
      session: args.session,
      host: resolveAiVaultResumeHostShell({
        session: args.session,
        workspacePlatform: args.workspacePlatform,
        // Why: the command is typed into the host's new pane, so quote for its live shell, not the phone's.
        localLiveShell: () => resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
      }),
      settings: args.settings,
      commandOverride,
      embedCwd: true
    })
  const { providerSession, ...launch } = startup
  return {
    ...launch,
    ...(startup.launchConfig && isTuiAgent(args.session.agent)
      ? { launchAgent: args.session.agent }
      : {}),
    ...(providerSession ? { resumeProviderSession: providerSession } : {})
  }
}

export async function resumeAiVaultSessionInTerminal(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  launch: MobileAiVaultResumeLaunch & {
    clientMutationId?: string
    hostCapabilities?: readonly string[]
    viewMode?: 'chat'
  },
  assertCurrentOwner?: () => void
): Promise<MobileReviewTerminalTab & { agentProgramBlocked?: AgentProgramBlockReason }> {
  assertCurrentOwner?.()
  const historyResume = launch.hostCapabilities?.includes(
    SESSION_HISTORY_TERMINAL_CREATE_CAPABILITY
  )
  const launchAtCreate =
    Boolean(launch.clientMutationId) &&
    (historyResume ||
      (launch.launchAgent === 'qoder' &&
        launch.hostCapabilities?.includes(QODER_OWNED_TERMINAL_CREATE_CAPABILITY)))
  const { [GENERATED_AGENT_LAUNCH_ENV]: generatedAgentLaunch, ...env } = launch.env ?? {}
  // Await requests outside refusal handling so transport errors keep their original delivery-unknown identity.
  const created = await reviewTerminalCreateRun.request(
    client,
    {
      worktree: `id:${worktreeId}`,
      ...(launchAtCreate ? { command: launch.command } : {}),
      ...(launchAtCreate && historyResume ? { historyResume: true } : {}),
      ...(launchAtCreate && generatedAgentLaunch ? { generatedAgentLaunch } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      // Older hosts strip it and learn the session from the agent's first report instead.
      ...(launch.resumeProviderSession
        ? { resumeProviderSession: launch.resumeProviderSession }
        : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {}),
      ...(launch.viewMode ? { viewMode: launch.viewMode } : {}),
      activate: false,
      select: true,
      navigation: 'caller'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  let terminalTab
  terminalTab = interpretOrThrowRefusalMessage(
    () => reviewTerminalCreateRun.interpret(created),
    translate('session.aiVaultResumeLaunch.createFailed', 'Failed to create terminal')
  )
  if (launchAtCreate) {
    return terminalTab
  }
  assertCurrentOwner?.()
  const sent = await reviewTerminalSendRun.request(
    client,
    {
      terminal: terminalTab.terminal,
      text: launch.command,
      enter: true
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  let accepted
  accepted = interpretOrThrowRefusalMessage(
    () => reviewTerminalSendRun.interpret(sent),
    translate('session.aiVaultResumeLaunch.sendFailed', 'Failed to send resume command')
  )
  if (!accepted) {
    throw new Error(
      translate('session.aiVaultResumeLaunch.inputLocked', 'Terminal input is locked')
    )
  }
  return terminalTab
}

export type MobileAiVaultResumeMutationRegistry = {
  claim(sessionId: string): string
  releaseOnSuccess(sessionId: string): void
}

// Reuse mutation ids after failed/interrupted resumes for deduplication; mint fresh only after success so deliberate forks remain possible.
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
  targetStatus: AiVaultResumeTargetStatus,
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
