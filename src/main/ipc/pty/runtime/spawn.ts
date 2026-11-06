import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { getProvider } from '../provider/registry'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isClaudeLaunchCommand } from '../host-env/fresh-spawn-routing'
import { runPtySpawn, normalizePtySpawnSessionId } from '../spawn-operation'
import { requireAcceptedSpawn } from '../spawn-outcome'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { applyAgentLaunchPluginHook } from '../spawn-agent-launch-plugin-hook'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { commitRuntimePtySpawn } from './spawn-commit'
import { resolveRuntimeClaudeAuth } from './spawn-claude-auth'
import { beginRuntimePaneReplacement } from './spawn-replacement'
import { resolveRuntimeHostSessionBinding } from './spawn-host-binding'
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
  const replacesPtyId = args.replacesPtyId
  const ctx = createRuntimePtySpawnState(deps, args)
  if (replacesPtyId !== undefined) {
    getProvider(getConnectionExecutionHostId(args.connectionId))
    ctx.hostSessionBinding = resolveRuntimeHostSessionBinding(deps, args)
    if (!ctx.hostSessionBinding) {
      throw new Error('replacesPtyId requires persistHostSessionBinding')
    }
    if (args.adoptedStablePane || args.agentSessionEnsure) {
      throw new Error('terminal_pane_owner_unknown')
    }
  }
  const outcome = await runPtySpawn({
    state: ctx,
    prepare: async () => {
      ctx.args = await applyAgentLaunchPluginHook(ctx.args, deps.runtime)
      await prepareRuntimePtySpawn(ctx)
      await buildRuntimePtySpawnOptions(ctx)
    },
    facts: () => ({
      sessionId: ctx.sessionId,
      savedResumePaneKey: ctx.spawnIdentityPaneKey,
      launchConfig: ctx.args.launchConfig,
      suppressRefusedLaunch: () => {
        ctx.launchCommand = undefined
        ctx.env = ctx.spawnOptions.env
      },
      paneKey: ctx.spawnIdentityPaneKey,
      preAllocatedHandle: args.preAllocatedHandle,
      replacedPaneOwner: ctx.replacedPaneOwner,
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
    adoption: () => ({ completed: args.adoptedStablePane }),
    ...(replacesPtyId !== undefined
      ? {
          replace: async () => {
            // Validate the target account before stopping the current session.
            if (args.claudeAccountId !== undefined && isClaudeLaunchCommand(args.command)) {
              ctx.claudeAuth = await resolveRuntimeClaudeAuth(ctx)
            }
            const binding = ctx.hostSessionBinding
            if (!binding) {
              throw new Error('replacesPtyId requires persistHostSessionBinding')
            }
            const replacement = await beginRuntimePaneReplacement(deps, {
              replacesPtyId,
              paneKey: makePaneKey(binding.tabId, binding.leafId),
              worktreeId: args.worktreeId,
              connectionId: args.connectionId,
              reservation: ctx.paneSpawnReservation ?? undefined
            })
            ctx.replacedPaneOwner = replacement.replaced
          }
        }
      : {})
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
