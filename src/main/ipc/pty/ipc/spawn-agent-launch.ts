import { randomUUID } from 'node:crypto'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type {
  AgentLaunchSnapshot,
  LaunchIntent
} from '../../../../shared/agent-launch-host-contract'
import type {
  AgentLaunchSpawnOutcome,
  AgentLaunchSpawnRequest
} from '../../../../shared/agent-launch-spawn-request'
import { resolveStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../../shared/types'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'
import {
  describeSpawnExecutionHost,
  deriveAgentLaunchHostState,
  detectionUnavailable,
  resolveLocalTargetHomePath
} from '../../../agent-launch/agent-launch-host-state'
import {
  resolveAgentLaunchSpawn,
  sanitizeClientAgentLaunchSourceRecord
} from '../../../agent-launch/agent-launch-spawn'
import { resolveResumeLaunchIngest } from '../../../agent-launch/agent-launch-resume-ingest'
import { resolveRevalidatedVaultResume } from '../../../agent-launch/agent-launch-vault-resume'
import { getHostAgentSessionRecordStore } from '../../../agent-launch/agent-session-record-store-host'
import { getHostAgentLaunchBoundary } from '../../../agent-launch/agent-launch-boundary-host'
import { getHostBackgroundAgentLaunchStore } from '../../../agent-launch/background-agent-launch-store-host'
import { mintAgentLaunchOperationId } from '../../../agent-launch/agent-launch-operation-store'
import {
  beginBackgroundDeclarationLaunch,
  settleBackgroundDeclarationResolution,
  settleBackgroundDeclarationSpawn,
  type BackgroundDeclarationDeps,
  type BackgroundDeclarationLaunch
} from '../../../agent-launch/background-agent-launch-spawn-declaration'
import { revalidateAiVaultResumeEntry } from '../../ai-vault-resume-command'
import {
  discoverAiVaultSessionsAcrossHosts,
  getAiVaultSessionResumePreparation
} from '../../ai-vault'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { mergeTerminalEnvDeletionKeys } from '../../../../shared/terminal-env-deletion-keys'
import type { PtyIpcSpawnState } from './spawn-state'

export type AgentLaunchEarlyResult = { agentLaunch: AgentLaunchSpawnOutcome }

export async function resolvePtyIpcAgentLaunch(
  ctx: PtyIpcSpawnState
): Promise<AgentLaunchEarlyResult | null> {
  const args = ctx.args
  if (ctx.preAdoptedStablePane || !args.agentLaunch || !ctx.deps.getSettings) {
    return null
  }

  const getLaunchSettings = ctx.deps.getSettings
  const descriptor = describeSpawnExecutionHost({
    connectionId: args.connectionId,
    cwd: ctx.cwd ?? args.cwd,
    shellOverride: args.shellOverride,
    terminalWindowsShell: getLaunchSettings()?.terminalWindowsShell,
    projectRuntime: args.projectRuntime
  })
  const hostState = await deriveAgentLaunchHostState(
    {
      getSettings: getLaunchSettings,
      getCatalogRevision: () => getLaunchSettings()?.agentCatalogRevision ?? 1,
      detectStockBaseAgents: detectionUnavailable,
      resolveTargetHomePath: resolveLocalTargetHomePath,
      resolveStartupShell: async (target) => {
        if (target.kind !== 'ssh' || target.platform !== 'win32') {
          return undefined
        }
        const shell = args.shellOverride ?? (await ctx.provider.getDefaultShell())
        return resolveWindowsShellStartupFamily(shell)
      }
    },
    descriptor,
    { worktreePath: ctx.cwd ?? null, repoPath: null }
  )
  let resumeRequest: AgentLaunchSpawnRequest | null = null
  let resumeIntent: LaunchIntent = { kind: 'interactive', client: 'desktop' }
  let resumePersistedSnapshot: AgentLaunchSnapshot | undefined
  let resumeProviderSession: AgentProviderSessionMetadata | undefined
  let backgroundDeclaration: BackgroundDeclarationLaunch | null = null
  let backgroundDeclarationRequestedAgent: TuiAgent | null = null
  const backgroundDeclarationDeps: BackgroundDeclarationDeps = {
    createAttempt: (input) => getHostBackgroundAgentLaunchStore().create(input),
    settleLaunched: (attemptId) => getHostBackgroundAgentLaunchStore().settleLaunched(attemptId),
    settleFailed: (attemptId, failure) =>
      getHostBackgroundAgentLaunchStore().settleFailed(attemptId, failure),
    rollback: (attemptId) => getHostBackgroundAgentLaunchStore().delete(attemptId),
    mintAttemptId: () => randomUUID(),
    mintOperationId: () => mintAgentLaunchOperationId(),
    mintFailureId: () => randomUUID()
  }

  if ('resume' in args.agentLaunch) {
    const ingest = resolveResumeLaunchIngest(
      {
        resume: args.agentLaunch.resume,
        client: 'desktop',
        legacy: {
          shell: resolveStartupShell(hostState.target.platform, hostState.target.shell),
          connectionId: args.connectionId ?? null,
          ...(args.launchConfig
            ? {
                handoff: {
                  launchConfig: args.launchConfig,
                  recordedConnectionId: args.legacyResumeRecordedConnectionId ?? null,
                  ...(args.resumeProviderSession?.transcriptPath
                    ? { transcriptPath: args.resumeProviderSession.transcriptPath }
                    : {})
                }
              }
            : {})
        }
      },
      getHostAgentSessionRecordStore()
    )
    if (!ingest.ok) {
      return { agentLaunch: { status: 'failed', failure: ingest.failure } }
    }
    if (ingest.kind === 'legacy') {
      args.command = ingest.launchCommand
      args.commandDelivery = 'provider'
      args.launchConfig = ingest.launchConfig
      args.launchAgent = ingest.baseAgent
      if (ingest.launchConfig.agentEnv) {
        args.env = { ...args.env, ...ingest.launchConfig.agentEnv }
      }
      return null
    }
    resumeRequest = ingest.request
    resumeIntent = ingest.intent
    resumePersistedSnapshot = ingest.persistedSnapshot
    resumeProviderSession = ingest.resumeProviderSession
  } else if ('vaultResume' in args.agentLaunch) {
    const vault = args.agentLaunch.vaultResume
    if (vault.operation !== 'resume') {
      return {
        agentLaunch: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
      }
    }
    const session = await revalidateAiVaultResumeEntry(
      vault.entry,
      discoverAiVaultSessionsAcrossHosts,
      getAiVaultSessionResumePreparation()
    )
    if (!session) {
      return {
        agentLaunch: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
      }
    }
    const vaultResolution = resolveRevalidatedVaultResume({
      session,
      sessionRecordStore: getHostAgentSessionRecordStore(),
      targetExecutionHostId: hostState.target.executionHostId,
      targetPlatform: hostState.target.platform,
      preferredWorktreeId:
        typeof args.worktreeId === 'string' && args.worktreeId.length > 0 ? args.worktreeId : null,
      settings: getLaunchSettings()
    })
    if (vaultResolution.kind === 'snapshot') {
      const ingest = resolveResumeLaunchIngest(
        { resume: vaultResolution.request.resume, client: 'desktop' },
        getHostAgentSessionRecordStore()
      )
      if (!ingest.ok || ingest.kind !== 'snapshot') {
        return {
          agentLaunch: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
        }
      }
      resumeRequest = ingest.request
      resumeIntent = ingest.intent
      resumePersistedSnapshot = ingest.persistedSnapshot
      resumeProviderSession = ingest.resumeProviderSession
    } else {
      const startup = vaultResolution.startup
      args.command = startup.command
      args.commandDelivery = 'provider'
      if (startup.env) {
        args.env = { ...args.env, ...startup.env }
      }
      if (startup.envToDelete) {
        args.envToDelete = mergeTerminalEnvDeletionKeys(args.envToDelete, startup.envToDelete)
      }
      if (startup.launchConfig) {
        args.launchConfig = startup.launchConfig
      }
      args.launchAgent = session.agent
      ctx.vaultLaunchNotices = vaultResolution.launchNotices ?? null
      return null
    }
  } else {
    resumeRequest = sanitizeClientAgentLaunchSourceRecord(args.agentLaunch)
    if (
      args.agentLaunch.unattended?.kind === 'background' &&
      args.agentLaunch.selection.kind === 'agent' &&
      typeof args.worktreeId === 'string' &&
      args.worktreeId.length > 0
    ) {
      backgroundDeclarationRequestedAgent = args.agentLaunch.selection.agent
      backgroundDeclaration = beginBackgroundDeclarationLaunch(backgroundDeclarationDeps, {
        worktreeId: args.worktreeId,
        requestedAgent: args.agentLaunch.selection.agent
      })
      resumeIntent = backgroundDeclaration.intent
    }
  }

  if (!resumeRequest) {
    return null
  }
  const recipeRepo =
    ctx.deps.store && typeof args.worktreeId === 'string' && args.worktreeId.length > 0
      ? (ctx.deps.store.getRepo(getRepoIdFromWorktreeId(args.worktreeId)) ?? null)
      : null
  const resolution = await resolveAgentLaunchSpawn(
    {
      getSettings: hostState.getSettings,
      getCatalogRevision: hostState.getCatalogRevision,
      boundary: getHostAgentLaunchBoundary()
    },
    {
      request: resumeRequest,
      intent: resumeIntent,
      target: hostState.target,
      variables: hostState.variables,
      recipeRepo,
      scope:
        backgroundDeclaration?.scope ??
        (typeof args.worktreeId === 'string' && args.worktreeId.length > 0
          ? args.worktreeId
          : 'local-pty-spawn'),
      worktreeId:
        typeof args.worktreeId === 'string' && args.worktreeId.length > 0 ? args.worktreeId : null,
      principal: { kind: 'local' },
      ...(resumePersistedSnapshot ? { persistedSnapshot: resumePersistedSnapshot } : {}),
      ...(resumeProviderSession ? { resumeProviderSession } : {})
    }
  )
  if (!resolution.ok) {
    const settled = backgroundDeclaration
      ? settleBackgroundDeclarationResolution(
          backgroundDeclarationDeps,
          backgroundDeclaration.attemptId,
          resolution
        )
      : null
    const backgroundAttemptId =
      settled?.attemptRetained && backgroundDeclaration
        ? { backgroundAttemptId: backgroundDeclaration.attemptId }
        : {}
    return 'failure' in resolution
      ? {
          agentLaunch: {
            status: 'failed',
            failure: resolution.failure,
            ...backgroundAttemptId
          }
        }
      : { agentLaunch: { status: 'rejected', requestError: resolution.requestError } }
  }

  let settled = false
  ctx.agentLaunchToken = resolution.receipt.launchToken
  ctx.agentLaunchOutcome = {
    status: 'launched',
    receipt: resolution.receipt,
    ...(backgroundDeclaration ? { backgroundAttemptId: backgroundDeclaration.attemptId } : {})
  }
  ctx.settleAgentLaunch = (settlement) => {
    if (settled || !ctx.agentLaunchToken) {
      return
    }
    settled = true
    ctx.agentLaunchSettlement = settlement
    getHostAgentLaunchBoundary().settleAgentLaunch(ctx.agentLaunchToken, settlement)
    if (backgroundDeclaration && backgroundDeclarationRequestedAgent) {
      settleBackgroundDeclarationSpawn(
        backgroundDeclarationDeps,
        backgroundDeclaration,
        settlement,
        backgroundDeclarationRequestedAgent
      )
    }
  }
  args.command = resolution.plan.launchCommand
  args.commandDelivery = 'provider'
  args.launchConfig = resolution.plan.launchConfig
  args.launchAgent = resolution.receipt.baseAgent
  args.launchToken = resolution.receipt.launchToken
  if (args.telemetry) {
    args.telemetry = {
      ...args.telemetry,
      agent_kind: resolution.receipt.telemetry.agentKind,
      used_custom_agent: resolution.receipt.telemetry.usedCustomAgent
    }
  }
  if (resolution.plan.startupCommandDelivery !== undefined) {
    args.startupCommandDelivery = resolution.plan.startupCommandDelivery
  }
  args.env = {
    ...args.env,
    ...resolution.plan.env,
    ORCA_AGENT_LAUNCH_TOKEN: resolution.receipt.launchToken
  }
  ctx.agentLaunchFollowupPrompt = resolution.plan.followupPrompt
  ctx.agentLaunchDraftPrompt = resolution.plan.draftPrompt ?? null
  return null
}
