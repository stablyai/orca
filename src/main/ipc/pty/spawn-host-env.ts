import { getClaudeAgentViewService } from '../../claude/agent-view-service'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { stampRuntimeSourceEnv } from '../../../shared/runtime-source-env'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { isAgentStatusHooksEnabled } from '../../agent-hooks/managed-agent-hook-controls'
import { awaitExplicitAgentPluginGuestReadiness } from '../../agent-hooks/wsl-agent-plugin-readiness'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../codex/codex-state-db-backfill-recovery'
import type { CodexSessionResumePreparation } from '../../codex/codex-session-resume-home'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import { isSafePtySessionId } from '../../daemon/pty-session-id'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import { stampWslOrchestrationCompatibilityHost } from '../../pty/wsl-orca-env'
import { getRuntimeSourceStamp } from '../../runtime/host-descriptor'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { buildPtyHostEnv } from './host-env/assembly'
import {
  codexHomePathsEqual,
  getCompatibleSelectedCodexHomePath,
  resolveCodexHomeAfterManagedAuthReadiness,
  shouldSkipCodexHomeEnvForWindowsShell,
  shouldStripInheritedOrcaCodexHome
} from './host-env/codex-home'
import type {
  CodexResumeLaunch,
  PrepareCodexResumeHomeArgs,
  PreparedCodexResumeHome
} from './host-env/codex-resume'
import { inheritOmpLaunchEnvironment } from './host-env/omp-launch-environment'
import { promoteAgentTeamsShimPath } from './host-env/path'
import type { GetSelectedCodexHomePath } from './host-env/types'
import { clearProviderPtyState } from './provider/state-cleanup'

export type PtySpawnCodexResumeDeps = {
  prepareCodexResumeHome: (args: PrepareCodexResumeHomeArgs) => PreparedCodexResumeHome | null
  resolveCodexResumeLaunch: (
    command: string | undefined,
    prepared: PreparedCodexResumeHome
  ) => Promise<CodexResumeLaunch>
  noCodexResumeLaunch: (command: string | undefined) => CodexResumeLaunch
  reconcileSharedRuntimeResumeHome: (
    resumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }>,
    resolveCurrent: () => string | null | Promise<string | null>
  ) => Promise<string>
  stripSequencedStartupResumeArgv: <T extends Record<string, string> | undefined>(
    env: T,
    launch: CodexResumeLaunch
  ) => T
}

export type PtySpawnHostEnv = {
  codexResumeLaunch: CodexResumeLaunch
  launchCommand: string | undefined
  /** Environment before host injection; window commits report this snapshot. */
  baseEnv: Record<string, string> | undefined
  env: Record<string, string> | undefined
  selectedCodexHomePath: string | null
  codexResumeHomeSelected: boolean
  skipCodexHomeEnv: boolean
  stripInheritedOrcaCodexHome: boolean
}

type PtySpawnHostEnvArgs = {
  launchAgent: TuiAgent | undefined
  command: string | undefined
  resumeProviderSession: AgentProviderSessionMetadata | undefined
  /** The lane's spawn env before Orca's host env. */
  env: Record<string, string> | undefined
  cwd: string | undefined
  shellOverride: string | undefined
  expectedWslDistro: string | null
  codexSelectionTarget: CodexAccountSelectionTarget
  /** An adopted stable pane launches nothing, so it gets no launch prep. */
  preAdopted: boolean
  isDaemonHostSpawn: boolean
  sessionId: string | undefined
  /** Only a launch whose caller named no session waits on a managed Codex login. */
  callerNamedSession: boolean
  /** A failed env build sweeps per-PTY state only for an id this request minted. */
  mintedSessionId: boolean
  /** An account-switch restart resumes onto the selected account; only the window has one. */
  resumeOnSelectedAccount: boolean
  /** Host accepts empty IDs without host env; window rejects them. */
  emptySessionIdSkipsHostEnv: boolean
  requestedAgentTeamsPath: string | undefined
  provider: IPtyProvider
  deps: PtySpawnCodexResumeDeps & {
    runtime?: OrcaRuntimeService
    getSettings?: () => GlobalSettings | undefined
    getSelectedCodexHomePath?: GetSelectedCodexHomePath
  }
  mark?: (phase: string) => void
}

export async function resolvePtySpawnHostEnv(args: PtySpawnHostEnvArgs): Promise<PtySpawnHostEnv> {
  const { deps, codexSelectionTarget: target } = args
  const codexResumePreparation = args.preAdopted
    ? null
    : deps.prepareCodexResumeHome({
        launchAgent: args.launchAgent,
        providerSession: args.resumeProviderSession,
        target,
        // Client-supplied CODEX_HOME can bypass host resume preparation.
        launchEnv: args.env,
        ...(args.resumeOnSelectedAccount ? { useSelectedAccount: true } : {})
      })
  const codexResumeLaunch = codexResumePreparation
    ? await deps.resolveCodexResumeLaunch(args.command, codexResumePreparation)
    : deps.noCodexResumeLaunch(args.preAdopted ? undefined : args.command)
  // Time provenance/hook repair, auth selection and env assembly separately to attribute their different costs.
  args.mark?.('codex_resume')
  const codexResumeHome = codexResumeLaunch.codexResumeHome
  const launchCommand = codexResumeLaunch.command
  const baseEnv = deps.stripSequencedStartupResumeArgv(args.env, codexResumeLaunch)
  const launchesCodex = args.launchAgent === 'codex'
  const selectLaunchCodexHome = async (): Promise<string | null> =>
    (await deps.getSelectedCodexHomePath?.(target, baseEnv, { launchesCodex })) ?? null
  let selectedCodexHomePath = !args.preAdopted
    ? getCompatibleSelectedCodexHomePath(
        target,
        codexResumeHome
          ? await deps.reconcileSharedRuntimeResumeHome(codexResumeHome, async () =>
              getCompatibleSelectedCodexHomePath(target, await selectLaunchCodexHome())
            )
          : await selectLaunchCodexHome()
      )
    : null
  if (!args.preAdopted && launchesCodex && !args.callerNamedSession) {
    const resolution = resolveCodexHomeAfterManagedAuthReadiness({
      selectedCodexHomePath,
      getSettings: () => deps.getSettings?.(),
      requiredCodexHomePath: codexResumeHome?.codexHomePath,
      target,
      resolveCurrent: async () =>
        getCompatibleSelectedCodexHomePath(
          target,
          (await deps.getSelectedCodexHomePath?.(target, baseEnv, { launchesCodex })) ?? null
        ),
      resolveAfterUnavailable: async (unavailableManagedHomePath) =>
        getCompatibleSelectedCodexHomePath(
          target,
          (await deps.getSelectedCodexHomePath?.(target, baseEnv, {
            unavailableManagedHomePath,
            launchesCodex
          })) ?? null
        )
    })
    selectedCodexHomePath = resolution instanceof Promise ? await resolution : resolution
  }
  if (launchesCodex && selectedCodexHomePath) {
    await ensureCodexStateDbBackfillRecoveryStarted(selectedCodexHomePath)
  }
  args.mark?.('codex_home')
  const isWsl = shouldSkipCodexHomeEnvForWindowsShell(args.shellOverride, args.cwd)
  const skipCodexHomeEnv = args.isDaemonHostSpawn && isWsl && !selectedCodexHomePath
  const ptySettings = args.isDaemonHostSpawn ? deps.getSettings?.() : undefined
  const hostEnv: PtySpawnHostEnv = {
    codexResumeLaunch,
    launchCommand,
    baseEnv,
    env: baseEnv,
    selectedCodexHomePath,
    codexResumeHomeSelected: Boolean(
      codexResumeHome && codexHomePathsEqual(selectedCodexHomePath, codexResumeHome.codexHomePath)
    ),
    skipCodexHomeEnv,
    stripInheritedOrcaCodexHome:
      args.isDaemonHostSpawn &&
      shouldStripInheritedOrcaCodexHome({
        target,
        selectedCodexHomePath,
        skipCodexHomeEnv,
        settings: ptySettings
      })
  }
  const sessionId = args.sessionId
  if (
    !args.isDaemonHostSpawn ||
    args.preAdopted ||
    (args.emptySessionIdSkipsHostEnv && !sessionId)
  ) {
    return hostEnv
  }
  if (sessionId === undefined) {
    // Daemon spawns require an ID before environment preparation.
    throw new Error('Invariant violation: daemon spawn without sessionId')
  }
  // Session IDs reach filesystem paths; reject traversal before any writes.
  if (!isSafePtySessionId(sessionId, getAppEnvironment().getPath('userData'))) {
    throw new Error('Invalid PTY session id')
  }
  const wslDistro = target.runtime === 'wsl' ? args.expectedWslDistro : null
  // Preserve caller environment for reused renderer/split requests.
  const env = { ...baseEnv }
  try {
    await inheritOmpLaunchEnvironment(env, {
      isWsl,
      launchAgent: args.launchAgent,
      launchCommand
    })
    await awaitExplicitAgentPluginGuestReadiness({
      settings: ptySettings,
      isWsl,
      distro: wslDistro,
      codexHomePath: selectedCodexHomePath,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
      launchCommand
    })
    await getClaudeAgentViewService().readyForLaunch({
      settings: ptySettings,
      isWsl,
      launchAgent: args.launchAgent,
      launchCommand
    })
    buildPtyHostEnv(sessionId, env, {
      isPackaged: getAppEnvironment().isPackaged(),
      resourcesPath: process.resourcesPath,
      userDataPath: getAppEnvironment().getPath('userData'),
      selectedCodexHomePath,
      skipCodexHomeEnv,
      stripInheritedOrcaCodexHome: hostEnv.stripInheritedOrcaCodexHome,
      launchCommand,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
      shellPath: args.shellOverride,
      isWsl,
      wslDistro,
      agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
      claudeSubagentNavigationEnabled: ptySettings?.claudeSubagentNavigationEnabled,
      terminalInlineImages: ptySettings?.terminalInlineImages,
      disabledTuiAgents: ptySettings?.disabledTuiAgents,
      networkProxySettings: ptySettings,
      routeBrowserOpensToClient: deps.runtime?.shouldRelayTerminalBrowserOpens?.(),
      deferGitConfigGuardToDaemon:
        args.provider.supportsGitCredentialGuardHost?.(sessionId) === true
    })
    stampWslOrchestrationCompatibilityHost(
      env,
      deps.runtime?.getOrchestrationCompatibilityHostId?.(),
      wslDistro
    )
    stampRuntimeSourceEnv(
      env,
      getRuntimeSourceStamp(deps.runtime, getAppEnvironment().getPath('userData'))
    )
    promoteAgentTeamsShimPath(env, args.requestedAgentTeamsPath)
  } catch (err) {
    // Host prep creates hook/extension state; only this request's minted ID is safe to sweep.
    if (args.mintedSessionId) {
      clearProviderPtyState(sessionId)
    }
    throw err
  }
  return { ...hostEnv, env }
}
