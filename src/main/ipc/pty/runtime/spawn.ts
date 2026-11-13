import { beginAccountRestartOperation } from '../pane/account-restart-owner'
import { readAccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { stopAndWaitPtyFromRuntimeController } from './kill'
import { runPtySpawn, normalizePtySpawnSessionId } from '../spawn-operation'
import { requireAcceptedSpawn } from '../spawn-outcome'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { applyAgentLaunchPluginHook } from '../spawn-agent-launch-plugin-hook'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import {
  commitRuntimeSpawnHiddenDelivery,
  markRuntimeSpawnHiddenBeforeSpawn,
  releaseRuntimeSpawnPreSpawnHiddenMark
} from './spawn-hidden-delivery'

/** Runtime projection stays inside the admitted start, so a rejected start withdraws its new pane. */
export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  request: RuntimePtySpawnArgs
) {
  const args = { ...request, sessionId: normalizePtySpawnSessionId(request.sessionId) }
  const condition = readAccountRestartCondition(args.accountRestart)
  if (
    args.accountRestart &&
    (!condition ||
      condition.pane.worktreeId !== args.worktreeId ||
      condition.pane.tabId !== args.tabId ||
      condition.pane.leafId !== args.leafId)
  ) {
    throw new Error('invalid_account_restart')
  }
  const ctx = createRuntimePtySpawnState(deps, args)
  if (condition) {
    ctx.accountRestartOperation = beginAccountRestartOperation(condition)
  }
  const outcome = await runPtySpawn({
    state: ctx,
    ...(condition?.expected.kind === 'endpoint'
      ? {
          replace: async () => {
            const operation = ctx.accountRestartOperation!
            operation.stop = 'unknown'
            if (
              !(await stopAndWaitPtyFromRuntimeController(
                deps,
                condition.expected.kind === 'endpoint' ? condition.expected.ptyId : '',
                { keepHistory: true }
              ))
            ) {
              throw new Error('terminal_replaced_pty_stop_unverified')
            }
            operation.stop = 'confirmed-retired'
            ctx.replacedPaneOwner = {
              ptyId: condition.expected.kind === 'endpoint' ? condition.expected.ptyId : '',
              pane: {
                ...condition.pane,
                hostId: args.connectionId ? `ssh:${args.connectionId}` : undefined
              }
            }
          }
        }
      : {}),
    prepare: async () => {
      ctx.args = await applyAgentLaunchPluginHook(ctx.args, deps.runtime)
      await prepareRuntimePtySpawn(ctx)
      await buildRuntimePtySpawnOptions(ctx)
    },
    facts: () => ({
      sessionId: ctx.sessionId,
      replacedPaneOwner: ctx.replacedPaneOwner,
      savedResumePaneKey: ctx.spawnIdentityPaneKey,
      launchConfig: ctx.args.launchConfig,
      suppressRefusedLaunch: () => {
        ctx.launchCommand = undefined
        ctx.env = ctx.spawnOptions.env
      },
      paneKey: ctx.spawnIdentityPaneKey,
      preAllocatedHandle: args.preAllocatedHandle,
      beforeProviderSpawn: () => markRuntimeSpawnHiddenBeforeSpawn(ctx),
      reportPtySpawnCommitted: () => ctx.reportPtySpawnCommitted()
    }),
    commit: () => {
      if (!ctx.result.isReattach) {
        Object.assign(ctx.result, {
          ...(ctx.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
          launchConfig: ctx.args.launchConfig,
          launchAgent: ctx.args.launchAgent,
          launchToken: ctx.args.launchToken,
          resumeProviderSession: ctx.codexResumeArgvDropped
            ? undefined
            : ctx.args.resumeProviderSession
        })
      }
      return commitRuntimePtySpawn(ctx)
    },
    onCommitted: () => commitRuntimeSpawnHiddenDelivery(ctx),
    releaseHiddenMark: () => releaseRuntimeSpawnPreSpawnHiddenMark(ctx),
    adoption: () => ({ completed: args.adoptedStablePane })
  })
  const result = requireAcceptedSpawn(outcome)
  let stablePaneOwner = result.stablePaneOwner
  if (outcome.owner && args.worktreeId) {
    const handle = stablePaneOwner?.handle ?? outcome.owner.handle ?? args.preAllocatedHandle
    if (!handle) {
      throw new Error('terminal_pane_owner_unknown')
    }
    stablePaneOwner = { handle, tabId: outcome.owner.tabId, leafId: outcome.owner.leafId }
  }
  return {
    ...result,
    wslDistro: result.wslDistro ?? undefined,
    ...(stablePaneOwner ? { stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
    ...(result.startupCwdFallback ? { startupCwdFallback: result.startupCwdFallback } : {})
  }
}
