import { isNativeWindowsLocalPtySpawn } from '../../../runtime/terminal/output/terminal-model-query-authority'
import { resolvePtySpawnHostEnv } from '../host-env/spawn-host-env'
import type { PtyIpcSpawnState } from './spawn-state'
import { resolveCodexAccountRestartResume } from '../account-restart/codex-account-restart-resume-gate'

export async function assemblePtyIpcSpawnCodexEnv(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  ctx.effectiveShellOverride = ctx.terminalRuntimeOptions.shellOverride
  ctx.nativeWindowsConptySpawn = isNativeWindowsLocalPtySpawn({
    connectionId: args.connectionId,
    cwd: args.cwd,
    shellOverride: ctx.effectiveShellOverride
  })
  const restartResume = await resolveCodexAccountRestartResume({
    launchAgent: args.launchAgent,
    resumeProviderSession: args.resumeProviderSession,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: ctx.validatedLeafId ?? args.leafId,
    preAdopted: Boolean(ctx.preAdoptedStablePane),
    replacesPtyId: args.replacesPtyId,
    connectionId: args.connectionId,
    selectionRuntime: ctx.codexSelectionTarget.runtime ?? 'host',
    isDaemonHostSpawn: ctx.isDaemonHostSpawn
  })
  const hostEnv = await resolvePtySpawnHostEnv({
    launchAgent: args.launchAgent,
    command: args.command,
    resumeProviderSession: restartResume.providerSession,
    env: ctx.baseEnv,
    cwd: ctx.cwd,
    shellOverride: ctx.effectiveShellOverride,
    expectedWslDistro: ctx.expectedWslDistro,
    codexSelectionTarget: ctx.codexSelectionTarget,
    preAdopted: Boolean(ctx.preAdoptedStablePane),
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    sessionId: ctx.effectiveSessionId,
    callerNamedSession: args.sessionId !== undefined,
    mintedSessionId: ctx.ownsNewIncarnation,
    resumeOnSelectedAccount: Boolean(args.replacesPtyId) || restartResume.resumeOnSelectedAccount,
    emptySessionIdSkipsHostEnv: false,
    wslPassiveRestore: args.wslPassiveRestore === true,
    requestedAgentTeamsPath: ctx.requestedAgentTeamsPath,
    provider: ctx.provider,
    deps: ctx.deps,
    mark: (phase) => ctx.spawnTiming.mark(phase)
  }).catch((error: unknown) => {
    restartResume.unspend?.()
    throw error
  })
  ctx.codexResumeLaunch = hostEnv.codexResumeLaunch
  if (hostEnv.codexResumeLaunch.droppedResumeArgv && ctx.effectiveLaunchConfig) {
    ctx.effectiveLaunchConfig = {
      ...ctx.effectiveLaunchConfig,
      agentCommand: hostEnv.launchCommand ?? ctx.effectiveLaunchConfig.agentCommand
    }
  }
  ctx.launchCommand = hostEnv.launchCommand
  ctx.baseEnv = hostEnv.baseEnv
  ctx.env = hostEnv.env
  ctx.selectedCodexHomePath = hostEnv.selectedCodexHomePath
  ctx.codexResumeHomeSelected = hostEnv.codexResumeHomeSelected
  ctx.skipCodexHomeEnv = hostEnv.skipCodexHomeEnv
  ctx.stripInheritedOrcaCodexHome = hostEnv.stripInheritedOrcaCodexHome
  ctx.spawnTiming.mark('host_env')
}
