import { SESSION_TABS_OWNED_STARTUP_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../src/shared/agent-session/lifecycle/agent-session-resume'
import {
  buildAiVaultLocalResumeStartup,
  buildAiVaultForkStartup,
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
import { reviewTerminalCreateRun } from '../source-control/review/terminal-delivery/mobile-review-terminal-operations'
import type { MobileReviewTerminalTab } from '../source-control/review/terminal-delivery/review-terminal-reply-schema'
import type { AiVaultResumeTargetStatus } from '../../../src/shared/ai-vault/resume/ai-vault-resume-target'
import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from '../../../src/shared/agent-launch/startup/qoder-terminal-create-capability'
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
  cwd?: string
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
  settings?: AiVaultResumeLaunchSettings | null
  fork?: boolean
}): MobileAiVaultResumeLaunch {
  const commandOverride = args.settings?.agentCmdOverrides?.[args.session.agent]
  const host = resolveAiVaultResumeHostShell({
    session: args.session,
    workspacePlatform: args.workspacePlatform,
    localLiveShell: () => resolveWindowsShellStartupFamily(args.hostTerminalWindowsShell)
  })
  const fork = args.fork
    ? buildAiVaultForkStartup({
        session: args.session,
        host,
        settings: args.settings,
        commandOverride
      })
    : null
  if (args.fork && !fork) {
    throw new Error(
      translate(
        'agentHistory.resume.forkUnsupported',
        'This agent cannot resume in a new CLI conversation.'
      )
    )
  }
  const startup =
    fork ??
    buildAiVaultRemoteResumeStartup(args.session, commandOverride) ??
    buildAiVaultLocalResumeStartup({
      session: args.session,
      host,
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
  },
  assertCurrentOwner?: () => void
): Promise<MobileReviewTerminalTab> {
  assertCurrentOwner?.()
  // Qoder's execution host must select its installed executable before the resume starts.
  const qoderOwnedCreate =
    launch.launchAgent === 'qoder' &&
    Boolean(launch.clientMutationId) &&
    launch.hostCapabilities?.includes(QODER_OWNED_TERMINAL_CREATE_CAPABILITY) === true
  const ownedStartup =
    launch.hostCapabilities?.includes(SESSION_TABS_OWNED_STARTUP_RUNTIME_CAPABILITY) === true
  if (!launch.clientMutationId || (!ownedStartup && !qoderOwnedCreate)) {
    throw new Error(
      translate(
        'agentHistory.resume.safeStartupUpdateRequired',
        'Update Orca on this host to resume safely from history.'
      )
    )
  }
  // Await requests outside refusal handling so transport errors keep their original delivery-unknown identity.
  const created = await reviewTerminalCreateRun.request(
    client,
    {
      worktree: `id:${worktreeId}`,
      command: launch.command,
      ...(ownedStartup ? { requireOwnedStartup: true } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      ...(launch.env ? { env: launch.env } : {}),
      ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
      ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
      ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
      // Older hosts strip it and learn the session from the agent's first report instead.
      ...(launch.resumeProviderSession
        ? { resumeProviderSession: launch.resumeProviderSession }
        : {}),
      ...(launch.clientMutationId ? { clientMutationId: launch.clientMutationId } : {}),
      activate: false,
      select: true,
      navigation: 'caller'
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS, beforeSend: assertCurrentOwner }
  )
  return interpretOrThrowRefusalMessage(
    () => reviewTerminalCreateRun.interpret(created),
    translate('session.aiVaultResumeLaunch.createFailed', 'Failed to create terminal')
  )
}

export type MobileAiVaultResumeMutationRegistry = {
  claim(sessionId: string): string
  claimLaunch(
    sessionId: string,
    create: () => MobileAiVaultResumeLaunch
  ): MobileAiVaultResumeLaunch & { clientMutationId: string }
  releaseOnSuccess(sessionId: string): void
}

// Reuse mutation ids after failed/interrupted resumes for deduplication; mint fresh only after success so deliberate forks remain possible.
export function createMobileAiVaultResumeMutationRegistry(
  mintId: (sessionId: string) => string
): MobileAiVaultResumeMutationRegistry {
  const bySessionId = new Map<string, string>()
  const launches = new Map<string, MobileAiVaultResumeLaunch & { clientMutationId: string }>()
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
    claimLaunch(sessionId, create) {
      const existing = launches.get(sessionId)
      if (existing) {
        return existing
      }
      const captured = { ...create(), clientMutationId: this.claim(sessionId) }
      launches.set(sessionId, captured)
      return captured
    },
    releaseOnSuccess(sessionId: string): void {
      launches.delete(sessionId)
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
