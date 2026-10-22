// The env a new PTY starts with and the Codex home it runs, for both the window and the host spawn lane.

import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { stampRuntimeSourceEnv } from '../../../shared/runtime-source-env'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { isAgentStatusHooksEnabled } from '../../agent-hooks/managed-agent-hook-controls'
import { awaitExplicitPiOmpGuestReadiness } from '../../agent-hooks/wsl-pi-omp-guest-readiness'
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

/** The Codex resume steps both lanes are handed (bound in register-handlers). */
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
  /** Before Orca's host env; TEMPORARY (rows 14-18 remove it): the window reports this one at commit. */
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
  /** TEMPORARY (row 7 removes it): the host builds no host env for an empty id; the window refuses it. */
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
        // Why: a host runtime skips resume prep for a launch whose env names a client-sent CODEX_HOME.
        launchEnv: args.env,
        ...(args.resumeOnSelectedAccount ? { useSelectedAccount: true } : {})
      })
  const codexResumeLaunch = codexResumePreparation
    ? await deps.resolveCodexResumeLaunch(args.command, codexResumePreparation)
    : deps.noCodexResumeLaunch(args.preAdopted ? undefined : args.command)
  // Why: these three phases have unrelated costs (session provenance + hook
  // repair, account/auth resolution, then the synchronous env build). One
  // `host_env` label hid all of them behind the name of the cheapest.
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
    // Should be unreachable: a daemon spawn always has an id; defense-in-depth.
    throw new Error('Invariant violation: daemon spawn without sessionId')
  }
  // Why: this id reaches filesystem paths; reject traversal/separators so a crafted payload can't escape the expected roots.
  if (!isSafePtySessionId(sessionId, getAppEnvironment().getPath('userData'))) {
    throw new Error('Invalid PTY session id')
  }
  const wslDistro = target.runtime === 'wsl' ? args.expectedWslDistro : null
  // Why: clone before mutating so injections don't leak back into the caller's env (renderer may reuse it).
  const env = { ...baseEnv }
  try {
    await inheritOmpLaunchEnvironment(env, {
      isWsl,
      launchAgent: args.launchAgent,
      launchCommand
    })
    await awaitExplicitPiOmpGuestReadiness({
      isWsl,
      distro: wslDistro,
      codexHomePath: selectedCodexHomePath,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
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
    // Why: host-env setup has fs side-effects (hooks, Pi/OMP install); only a minted id's state is ours to clear.
    if (args.mintedSessionId) {
      clearProviderPtyState(sessionId)
    }
    throw err
  }
  return { ...hostEnv, env }
}
