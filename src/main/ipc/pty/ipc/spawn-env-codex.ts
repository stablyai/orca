import { getAppEnvironment } from '../../../../shared/app-environment'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { isSafePtySessionId } from '../../../daemon/pty-session-id'
import { isNativeWindowsLocalPtySpawn } from '../../../runtime/terminal-model-query-authority'
import { stampWslOrchestrationCompatibilityHost } from '../../../pty/wsl-orca-env'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../../codex/codex-state-db-backfill-recovery'
import { buildPtyHostEnv } from '../host-env/assembly'
import {
  getCompatibleSelectedCodexHomePath,
  getCodexSelectionTargetForPty,
  resolveCodexHomeAfterManagedAuthReadiness,
  shouldSkipCodexHomeEnvForWindowsShell,
  shouldStripInheritedOrcaCodexHome,
  isCodexStatusHooksEnabled,
  codexHomePathsEqual
} from '../host-env/codex-home'
import { promoteAgentTeamsShimPath } from '../host-env/path'
import { clearProviderPtyState } from '../provider/state-cleanup'
import type { PtyIpcSpawnState } from './spawn-state'

export async function assemblePtyIpcSpawnCodexEnv(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  ctx.effectiveShellOverride = ctx.terminalRuntimeOptions.shellOverride
  ctx.nativeWindowsConptySpawn = isNativeWindowsLocalPtySpawn({
    connectionId: args.connectionId,
    cwd: args.cwd,
    shellOverride: ctx.effectiveShellOverride
  })
  ctx.codexSelectionTarget = getCodexSelectionTargetForPty(
    ctx.effectiveShellOverride,
    ctx.cwd,
    ctx.expectedWslDistro
  )
  const codexResumePreparation = ctx.preAdoptedStablePane
    ? null
    : ctx.deps.prepareCodexResumeHome({
        connectionId: args.connectionId,
        launchAgent: args.launchAgent,
        providerSession: args.resumeProviderSession,
        target: ctx.codexSelectionTarget,
        launchEnv: ctx.baseEnv,
        workspacePath: ctx.cwd
      })
  ctx.codexResumeLaunch = codexResumePreparation
    ? await ctx.deps.resolveCodexResumeLaunch(args.command, codexResumePreparation)
    : ctx.deps.noCodexResumeLaunch(ctx.preAdoptedStablePane ? undefined : args.command)
  // Why: these three phases have unrelated costs (session provenance + hook
  // repair, account/auth resolution, then the synchronous env build). One
  // `host_env` label hid all of them behind the name of the cheapest.
  ctx.spawnTiming.mark('codex_resume')
  const codexResumeHome = ctx.codexResumeLaunch.codexResumeHome
  ctx.launchCommand = ctx.codexResumeLaunch.command
  ctx.baseEnv = ctx.deps.stripSequencedStartupResumeArgv(ctx.baseEnv, ctx.codexResumeLaunch)
  // Why: declared after the strip so a local-provider spawn cannot capture the
  // pre-strip env — only the daemon branch below re-derives this from baseEnv.
  ctx.env = ctx.baseEnv
  const selectLaunchCodexHome = async (): Promise<string | null> =>
    (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.baseEnv, {
      workspacePath: ctx.cwd,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
    })) ?? null
  ctx.selectedCodexHomePath =
    !ctx.preAdoptedStablePane && !args.connectionId
      ? getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          codexResumeHome
            ? await ctx.deps.reconcileSharedRuntimeResumeHome(codexResumeHome, async () =>
                getCompatibleSelectedCodexHomePath(
                  ctx.codexSelectionTarget,
                  await selectLaunchCodexHome()
                )
              )
            : await selectLaunchCodexHome()
        )
      : null
  if (!ctx.preAdoptedStablePane && args.launchAgent === 'codex' && args.sessionId === undefined) {
    const resolution = resolveCodexHomeAfterManagedAuthReadiness({
      selectedCodexHomePath: ctx.selectedCodexHomePath,
      getSettings: () => ctx.deps.getSettings?.(),
      requiredCodexHomePath: codexResumeHome?.codexHomePath,
      target: ctx.codexSelectionTarget,
      resolveCurrent: async () =>
        getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.baseEnv, {
            workspacePath: ctx.cwd,
            launchAgent: 'codex'
          })) ?? null
        ),
      resolveAfterUnavailable: async (unavailableManagedHomePath) =>
        getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.baseEnv, {
            workspacePath: ctx.cwd,
            launchAgent: 'codex',
            unavailableManagedHomePath
          })) ?? null
        )
    })
    ctx.selectedCodexHomePath = resolution instanceof Promise ? await resolution : resolution
  }
  if (args.launchAgent === 'codex' && ctx.selectedCodexHomePath) {
    await ensureCodexStateDbBackfillRecoveryStarted(ctx.selectedCodexHomePath)
  }
  ctx.spawnTiming.mark('codex_home')
  ctx.codexResumeHomeSelected = Boolean(
    codexResumeHome && codexHomePathsEqual(ctx.selectedCodexHomePath, codexResumeHome.codexHomePath)
  )
  ctx.skipCodexHomeEnv =
    ctx.isDaemonHostSpawn &&
    shouldSkipCodexHomeEnvForWindowsShell(ctx.effectiveShellOverride, ctx.cwd) &&
    !ctx.selectedCodexHomePath
  const ptySettings = ctx.isDaemonHostSpawn ? ctx.deps.getSettings?.() : undefined
  ctx.stripInheritedOrcaCodexHome =
    ctx.isDaemonHostSpawn &&
    shouldStripInheritedOrcaCodexHome({
      target: ctx.codexSelectionTarget,
      selectedCodexHomePath: ctx.selectedCodexHomePath,
      skipCodexHomeEnv: ctx.skipCodexHomeEnv,
      settings: ptySettings
    })
  if (ctx.isDaemonHostSpawn && !ctx.preAdoptedStablePane) {
    if (ctx.effectiveSessionId === undefined) {
      // Should be unreachable: effectiveSessionId is a string when isDaemonHostSpawn; defense-in-depth.
      throw new Error('Invariant violation: daemon spawn without sessionId')
    }
    const sessionIdForEnv = ctx.effectiveSessionId
    // Why: this id reaches filesystem paths; reject traversal/separators so a crafted IPC payload can't escape the expected roots.
    if (!isSafePtySessionId(sessionIdForEnv, getAppEnvironment().getPath('userData'))) {
      throw new Error('Invalid PTY session id')
    }
    // Why: clone before mutating so injections don't leak back into args.env (renderer may reuse it).
    ctx.env = { ...ctx.baseEnv }
    try {
      buildPtyHostEnv(sessionIdForEnv, ctx.env, {
        isPackaged: getAppEnvironment().isPackaged(),
        resourcesPath: process.resourcesPath,
        userDataPath: getAppEnvironment().getPath('userData'),
        selectedCodexHomePath: ctx.selectedCodexHomePath,
        skipCodexHomeEnv: ctx.skipCodexHomeEnv,
        stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
        launchCommand: ctx.launchCommand,
        launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
        isWsl: shouldSkipCodexHomeEnvForWindowsShell(ctx.effectiveShellOverride, ctx.cwd),
        wslDistro: ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        codexStatusHooksEnabled: isCodexStatusHooksEnabled(ptySettings),
        networkProxySettings: ptySettings,
        routeBrowserOpensToClient: ctx.deps.runtime?.shouldRelayTerminalBrowserOpens?.(),
        deferGitConfigGuardToDaemon:
          ctx.provider.supportsGitCredentialGuardHost?.(ctx.effectiveSessionId) === true
      })
      stampWslOrchestrationCompatibilityHost(
        ctx.env,
        ctx.deps.runtime?.getOrchestrationCompatibilityHostId?.(),
        ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null
      )
      promoteAgentTeamsShimPath(ctx.env, ctx.requestedAgentTeamsPath)
    } catch (err) {
      // Why: buildPtyHostEnv has fs side-effects (Pi/OMP install); clear per-PTY state on throw, but only minted ids — caller ids may name existing PTYs.
      if (ctx.isMintedSessionId) {
        clearProviderPtyState(sessionIdForEnv)
      }
      throw err
    }
  }
  ctx.spawnTiming.mark('host_env')
}
