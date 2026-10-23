import { runtimeSpawnJoinPayload } from './spawn-commit-response'
import { isNativeWindowsLocalPtySpawn } from '../../../runtime/terminal-model-query-authority'
import { normalizeValidPaneKey } from '../pane/key-state'
import type { RuntimePtySpawnState } from './spawn-state'
import { startupCwdFallbackOutcome } from '../spawn-startup-target'
import { commitPtySpawn } from '../spawn-commit-assembly'
import type { PtySpawnPaneBinding } from '../spawn-commit-binding'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import { commitPtyWithOpenCodePromptIntent } from '../../../opencode/opencode-startup-prompt-owner'

export async function commitRuntimePtySpawn(ctx: RuntimePtySpawnState) {
  return commitPtyWithOpenCodePromptIntent(ctx, () => {
    const args = ctx.args
    const startupCwdFallback = startupCwdFallbackOutcome(ctx.startupCwdFallback, ctx.result)
    // Fallback may follow an access error; only proven absence authorizes changing the saved folder.
    const correctStartupCwd = startupCwdFallback ? ctx.correctStartupCwd : undefined
    const ensure = ctx.result.agentSessionEnsure
    return commitPtySpawn({
      state: ctx,
      nativeWindowsConptySpawn: isNativeWindowsLocalPtySpawn({
        connectionId: args.connectionId,
        cwd: args.cwd,
        shellOverride: ctx.daemonShellOverride
      }),
      seedPaneKey: ctx.spawnIdentityPaneKey,
      paneBinding: runtimeSpawnPaneBinding(ctx, correctStartupCwd),
      expectedSourceBinding: ctx.hostSessionBinding?.expectedSourceBinding,
      adoptedAgentSession: ensure?.disposition === 'adopted' ? ensure : undefined,
      registration: {
        store: ctx.hostSessionBinding?.store ?? ctx.deps.store,
        worktreeId: args.worktreeId,
        shellOverride: ctx.daemonShellOverride,
        rendererLaunchAuthority: null
      },
      preAllocatedHandle: args.preAllocatedHandle,
      // Why: runtime-owned CLI PTYs bypass the renderer pty:spawn handler; hook titles and cache cleanup need this reverse lookup.
      paneKey: normalizeValidPaneKey(ctx.env?.ORCA_PANE_KEY),
      memorySessionId: ctx.sessionId ?? null,
      resumeArgvDropped: ctx.codexResumeArgvDropped,
      codexLaunchEnv: ctx.env,
      initiallyHidden: args.initiallyHidden === true,
      hiddenDelivery: 'runtime-owned',
      earlyExit: 'throw',
      joinPayload: runtimeSpawnJoinPayload(ctx, startupCwdFallback, correctStartupCwd)
    })
  })
}

function runtimeSpawnPaneBinding(
  ctx: RuntimePtySpawnState,
  correctStartupCwd: string | undefined
): PtySpawnPaneBinding | undefined {
  if (!ctx.hostSessionBinding) {
    return undefined
  }
  const { store, worktreeId, tabId, leafId, expectedSourceBinding, placement } =
    ctx.hostSessionBinding
  const savedStartupCwd = correctStartupCwd ?? ctx.requestedCwd
  return {
    store,
    binding: {
      worktreeId,
      tabId,
      leafId,
      ptyId: ctx.result.id,
      // The runtime wrote the pane before spawning; a pane gone by now was closed meanwhile.
      mayCreate: false,
      ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
      ...(savedStartupCwd ? { startupCwd: savedStartupCwd } : {}),
      ...(correctStartupCwd ? { correctStartupCwd } : {}),
      ...(expectedSourceBinding ? { expectedSourceBinding } : {}),
      ...(placement ? { placement } : {}),
      origin: spawnCommitBindingOrigin(ctx.result, expectedSourceBinding)
    },
    absentOwner: ctx.args.paneSpawnOperation?.absentOwner,
    refusal: 'terminal_split_source_not_found',
    failureLog: '[pty] failed to persist runtime PTY binding after spawn:'
  }
}
