import {
  authorizeAccountRestartRetirement,
  beginAccountRestartOperation
} from '../pane/account-restart-owner'
import { readAccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { requireAcceptedSpawn } from '../spawn/spawn-outcome'
import { runPtySpawn, normalizePtySpawnSessionId } from '../spawn/spawn-operation'
import { checkPtyIpcLaunchPane, resolveEarlyPaneKey } from './spawn-begin'
import { stopReplacedPaneOwner } from '../pane/pane-owner-replacement'
import { keepAbsentBindingForSwap } from './spawn-absent-binding-swap'
import { planPaneAgentLaunch } from './spawn-agent-launch'
import { applyAgentLaunchPluginHook } from '../spawn/spawn-agent-launch-plugin-hook'
import { endPaneAgentLaunch } from './spawn-agent-launch-end'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { preparePtyIpcQoderCommand } from './spawn-qoder-command'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { attachOnlyViewOf } from '../pane/attach-only-view'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState } from './spawn-state'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { refuseClosedPaneSpawn } from './closed-pane-spawn-refusal'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { excludeReplacedPaneOwner } from '../pane/replaced-pane-owner'
import { withAgentLaunchToken } from '../../../agent-launch/agent-launch-token'

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, request: PtySpawnIpcArgs) {
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
  if (condition) {
    const expectedPtyId =
      condition.expected.kind === 'endpoint' ? condition.expected.ptyId : undefined
    if (
      args.attachOnlyView === true ||
      args.sessionId !== undefined ||
      (args.replacesPtyId !== undefined && args.replacesPtyId !== expectedPtyId)
    ) {
      throw new Error('invalid_account_restart')
    }
    args.replacesPtyId = expectedPtyId
    args.launchToken = condition.attemptId
    args.env = withAgentLaunchToken(args.env, condition.attemptId)
  }
  const ctx = createPtyIpcSpawnState(deps, args)
  if (condition) {
    ctx.accountRestartOperation = beginAccountRestartOperation(condition)
  }
  const admit = () => {
    triggerPtySpawnPushTargetMaterialization(deps, args)
    return checkPtyIpcLaunchPane(ctx)
  }
  const admission = args.replacesPtyId === undefined ? admit() : undefined
  const outcome = await runPtySpawn({
    state: ctx,
    admission,
    prepare: async () => {
      ctx.earlyStablePaneOwner = excludeReplacedPaneOwner(
        resolveStablePaneOwner(
          deps.runtime,
          deps.store,
          resolveEarlyPaneKey(ctx.args),
          ctx.args.worktreeId,
          ctx.args.connectionId
        ),
        ctx.replacedPaneOwner
      )
      ctx.earlyWorktreeId = ctx.args.worktreeId
      if (ctx.args.agentLaunch !== undefined) {
        await planPaneAgentLaunch(ctx)
      }
      if (!ctx.earlyStablePaneOwner) {
        ctx.args = await applyAgentLaunchPluginHook(ctx.args, deps.runtime)
      }
      await preparePtyIpcSpawnPreflight(ctx)
      await assemblePtyIpcSpawnEnv(ctx)
      await preparePtyIpcQoderCommand(ctx)
      await buildPtyIpcSpawnOptions(ctx)
    },
    facts: () => ({
      validateDispatch: () => {
        ctx.paneAgentLaunch?.refuseIfClosed()
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          refuseClosedPaneSpawn(deps.store, ctx.args.tabId, ctx.args.leafId)
        }
      },
      sessionId: ctx.effectiveSessionId,
      savedResumePaneKey: ctx.stablePaneKey,
      launchConfig: ctx.effectiveLaunchConfig,
      suppressRefusedLaunch: () => {
        ctx.launchCommand = undefined
        ctx.env = ctx.baseEnv = ctx.spawnEnv = ctx.spawnOptions.env
        ctx.effectiveLaunchConfig = undefined
      },
      paneKey: ctx.reservationPaneKey,
      preAllocatedHandle: ctx.preAllocatedHandle,
      replacedPaneOwner: ctx.replacedPaneOwner,
      attachOnlyView: attachOnlyViewOf(ctx.args),
      beforeProviderSpawn: () => {
        if (ctx.paneAgentLaunch) {
          ctx.paneAgentLaunch.dispatched = true
        }
      }
    }),
    drainsExitedStart: true,
    commit: () => commitPtyIpcSpawn(ctx),
    onOutcome: (settled) =>
      endPaneAgentLaunch(
        ctx,
        settled.kind === 'registration-exited'
          ? { exitedDuringStart: true, terminalStartFailure: settled.terminalStartFailure }
          : { started: true }
      ),
    onError: (error) => endPaneAgentLaunch(ctx, { error }),
    releasePreparation: () => {
      if (ctx.agentTeamsLeaderHandle) {
        deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
        ctx.agentTeamsLeaderHandle = null
      }
    },
    releaseHiddenMark: () => {
      if (ctx.preSpawnHiddenMarkId !== null) {
        deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
      }
    },
    adoption: () => ({ renderer: true, keepAbsentBinding: keepAbsentBindingForSwap(ctx) }),
    ...(args.replacesPtyId !== undefined
      ? {
          replace: async () => {
            ctx.replacedPaneOwner = await stopReplacedPaneOwner(deps, {
              expectedIncarnationId: ctx.accountRestartOperation?.original?.incarnationId,
              authorize: ctx.accountRestartOperation
                ? () => authorizeAccountRestartRetirement(ctx)
                : undefined,
              replacesPtyId: args.replacesPtyId!,
              paneKey: resolveEarlyPaneKey(args),
              worktreeId: args.worktreeId,
              connectionId: args.connectionId
            })
            if (ctx.accountRestartOperation && deps.store) {
              ctx.accountRestartOperation.stop = 'confirmed-retired'
            }
            await admit()
          }
        }
      : {})
  })
  return args.agentLaunch === undefined
    ? outcome.result
    : typeof args.agentLaunch === 'object' &&
        args.agentLaunch !== null &&
        'returnLaunchFailure' in args.agentLaunch &&
        args.agentLaunch.returnLaunchFailure === true
      ? requireAcceptedSpawn(outcome)
      : requireAcceptedSpawn(outcome, AGENT_LAUNCH_PANE_REFUSED_CODE)
}
