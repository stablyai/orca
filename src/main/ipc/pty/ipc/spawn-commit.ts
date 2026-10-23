import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { admitRendererAgentLaunchAuthority } from '../pane/launch-authority'
import type { PtyIpcSpawnState } from './spawn-state'
import { startupCwdFallbackOutcome } from '../spawn-startup-target'
import { commitPtySpawn } from '../spawn-commit-assembly'
import type { PtySpawnPaneBinding } from '../spawn-commit-binding'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import { parseTerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import { commitPtyWithOpenCodePromptIntent } from '../../../opencode/opencode-startup-prompt-owner'

export async function commitPtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<PtySpawnResult> {
  return commitPtyWithOpenCodePromptIntent(ctx, () => {
    const args = ctx.args
    // Why: args.worktreeId/sessionId arrive as untrusted IPC strings (type unenforced at the boundary); bound them so malformed/oversized values can't pollute registerPty's maps.
    const worktreeId =
      typeof args.worktreeId === 'string' &&
      args.worktreeId.length > 0 &&
      args.worktreeId.length <= 512
        ? args.worktreeId
        : null
    const response = ipcSpawnResponse(ctx)
    return commitPtySpawn<PtySpawnResult>({
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
        })
      },
      preAllocatedHandle: ctx.preAllocatedHandle,
      spawnTiming: ctx.spawnTiming,
      paneKey: ctx.validatedPaneKey,
      paneKeyAliases: {
        legacySpawnPaneKey: ctx.legacySpawnPaneKey,
        migrationUnsupportedPaneKey: ctx.migrationUnsupportedPaneKey,
        opaqueRemintedSpawnPaneKey: ctx.opaqueRemintedSpawnPaneKey
      },
      memorySessionId:
        typeof args.sessionId === 'string' &&
        args.sessionId.length > 0 &&
        args.sessionId.length <= 256
          ? args.sessionId
          : null,
      resumeArgvDropped: ctx.codexResumeLaunch.droppedResumeArgv,
      codexLaunchEnv: ctx.baseEnv,
      initiallyHidden: ctx.initiallyHidden,
      hiddenDelivery: 'renderer-scoped',
      earlyExit: 'drain',
      joinPayload: { reservation: response, reply: response }
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
  const { startupCwdSource: _startupCwdSource, ...providerResult } = ctx.result
  const startupCwdFallback = startupCwdFallbackOutcome(ctx.startupCwdFallback, ctx.result)
  return {
    ...providerResult,
    // Why both or neither: a pane can only adopt proven kitty flags together
    // with the sequence boundary they describe.
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    ...(!ctx.result.isReattach && ctx.effectiveLaunchConfig
      ? { launchConfig: ctx.effectiveLaunchConfig }
      : {}),
    ...(startupCwdFallback ? { startupCwdFallback } : {}),
    // Why: the pane asked to resume and got a fresh session instead; only the
    // renderer can say so, and a reattach never ran this launch command.
    ...(ctx.codexResumeLaunch.notifyResumeUnavailable && !ctx.result.isReattach
      ? { agentResumeUnavailable: true as const }
      : {})
  }
}
