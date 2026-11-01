import { provenSpawnResponse, type PtySpawnOutcome } from '../spawn-outcome'
import { admitRendererAgentLaunchAuthority } from '../pane/launch-authority'
import { resolveLaunchedAgent } from '../../../runtime/runtime-agent-launch-resolution'
import type { PtyIpcSpawnState } from './spawn-state'
import { startupCwdFallbackOutcome } from '../spawn-startup-target'
import { commitPtySpawn } from '../spawn-commit-assembly'
import type { PtySpawnPaneBinding } from '../spawn-commit-binding'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import { parseTerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import { commitPtyWithOpenCodePromptIntent } from '../../../opencode/opencode-startup-prompt-owner'
import { resumeSpawnRefusal, savedResumeResult } from '../host-env/saved-resume-admission'

export async function commitPtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<PtySpawnOutcome> {
  return commitPtyWithOpenCodePromptIntent(ctx, () => {
    const args = ctx.args
    // IPC workspace identity is untrusted; the actual provider result supplies memory identity.
    const worktreeId =
      typeof args.worktreeId === 'string' &&
      args.worktreeId.length > 0 &&
      args.worktreeId.length <= 512
        ? args.worktreeId
        : null
    const response = ipcSpawnResponse(ctx)
    const freshSpawn = ctx.result.isReattach !== true && ctx.stablePaneOwner === null
    return commitPtySpawn({
      state: ctx,
      nativeWindowsConptySpawn: ctx.nativeWindowsConptySpawn,
      seedPaneKey: ctx.validatedPaneKey,
      paneBinding: ipcSpawnPaneBinding(ctx),
      registration: {
        store: ctx.deps.store,
        worktreeId,
        shellOverride: ctx.effectiveShellOverride,
        rendererLaunchAuthority: admitRendererAgentLaunchAuthority({
          launchToken: args.launchToken,
          spawnEnv: ctx.spawnEnv,
          launchAgent: args.launchAgent,
          launchConfig: ctx.effectiveLaunchConfig,
          isReattach: ctx.result.isReattach === true,
          hasStablePaneOwner: ctx.stablePaneOwner !== null,
          incarnationId: ctx.result.incarnationId
        }),
        launchedAgent: freshSpawn ? resolveLaunchedAgent(args.command, args.launchAgent) : null
      },
      preAllocatedHandle: ctx.preAllocatedHandle,
      spawnTiming: ctx.spawnTiming,
      paneKey: ctx.validatedPaneKey,
      paneKeyAliases: {
        legacySpawnPaneKey: ctx.legacySpawnPaneKey,
        migrationUnsupportedPaneKey: ctx.migrationUnsupportedPaneKey,
        opaqueRemintedSpawnPaneKey: ctx.opaqueRemintedSpawnPaneKey
      },
      resumeArgvDropped: ctx.codexResumeLaunch.droppedResumeArgv,
      codexLaunchEnv: ctx.baseEnv,
      initiallyHidden: ctx.initiallyHidden,
      hiddenDelivery: 'renderer-scoped',
      response
    })
  })
}

function ipcSpawnPaneBinding(ctx: PtyIpcSpawnState): PtySpawnPaneBinding | undefined {
  const args = ctx.args
  // Persist the binding before acknowledging spawn so the renderer debounce cannot orphan history.
  if (
    !ctx.deps.store ||
    typeof args.worktreeId !== 'string' ||
    typeof args.tabId !== 'string' ||
    ctx.validatedLeafId === null
  ) {
    return undefined
  }
  const startupCwd = startupCwdFallbackOutcome(ctx.startupCwdFallback, ctx.result)
    ? (ctx.correctStartupCwd ?? ctx.requestedCwd)
    : ctx.requestedCwd
  const placement = parseTerminalPanePlacement(args.placement)
  return {
    store: ctx.deps.store,
    binding: {
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: ctx.validatedLeafId,
      ptyId: ctx.result.id,
      ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
      ...(startupCwd ? { startupCwd } : {}),
      ...(placement ? { placement } : {}),
      ...(ctx.paneSpawnOperation?.mustExist ? { mayCreate: false } : {}),
      origin: spawnCommitBindingOrigin(ctx.result)
    },
    absentOwner: ctx.paneSpawnOperation?.absentOwner,
    refusal: 'terminal_pane_owner_changed',
    failureLog: '[pty] failed to persist PTY binding after spawn:'
  }
}

function ipcSpawnResponse(ctx: PtyIpcSpawnState) {
  const args = ctx.args
  const { startupCwdSource: _startupCwdSource, ...providerResult } = ctx.result
  const startupCwdFallback = startupCwdFallbackOutcome(ctx.startupCwdFallback, ctx.result)
  return {
    ...provenSpawnResponse(providerResult, ctx.provedSnapshotSeq),
    ...(!ctx.result.isReattach && !resumeSpawnRefusal(ctx.resumeAdmission)
      ? {
          launchAgent: args.launchAgent,
          launchToken: typeof args.launchToken === 'string' ? args.launchToken : undefined,
          resumeProviderSession: ctx.codexResumeLaunch.droppedResumeArgv
            ? undefined
            : args.resumeProviderSession
        }
      : {}),
    ...(!ctx.result.isReattach && ctx.effectiveLaunchConfig
      ? { launchConfig: ctx.effectiveLaunchConfig }
      : {}),
    ...(startupCwdFallback ? { startupCwdFallback } : {}),
    ...resumeDisposition(ctx)
  }
}

/** What became of a requested resume, on every result the renderer receives. */
function resumeDisposition(ctx: PtyIpcSpawnState) {
  // Why: the pane asked to resume and got a fresh session instead; only the
  // renderer can say so, and a reattach never ran this launch command.
  if (ctx.result.isReattach) {
    return {}
  }
  const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
  return {
    ...(ctx.codexResumeLaunch.notifyResumeUnavailable || refusal
      ? { agentResumeUnavailable: true as const }
      : {}),
    ...savedResumeResult(ctx.resumeAdmission)
  }
}
