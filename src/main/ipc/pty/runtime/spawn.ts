import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'
import { isTerminalLeafId, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import { restoreProvisionalPtySize } from '../spawn-options-assembly'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { executeRuntimePtySpawn } from './spawn-execute'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import {
  commitRuntimeSpawnHiddenDelivery,
  releaseRuntimeSpawnPreSpawnHiddenMark
} from './spawn-hidden-delivery'

function toRuntimeSpawnReply(result: {
  id: string
  incarnationId?: string
  wslDistro?: string | null
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  startupCwdFallback?: StartupCwdFallback
  savedStartupCwd?: string
}) {
  return {
    savedStartupCwd: result.savedStartupCwd,
    id: result.id,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(typeof result.wslDistro === 'string' ? { wslDistro: result.wslDistro } : {}),
    ...(result.stablePaneOwner ? { stablePaneOwner: result.stablePaneOwner } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
    ...(result.startupCwdFallback ? { startupCwdFallback: result.startupCwdFallback } : {})
  }
}

export async function spawnPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  if (
    args.paneSpawnOperation ||
    !args.tabId ||
    !args.leafId ||
    !isValidTerminalTabId(args.tabId) ||
    !isTerminalLeafId(args.leafId)
  ) {
    return spawnFreshPtyFromRuntimeController(deps, args)
  }
  let freshResult: Awaited<ReturnType<typeof spawnFreshPtyFromRuntimeController>> | undefined
  const adopted = await deps.adoptStablePane({
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    connectionId: args.connectionId,
    preAllocatedHandle: args.preAllocatedHandle,
    signal: args.signal,
    completed: args.adoptedStablePane,
    spawnFresh: async (operation) => {
      freshResult = await spawnFreshPtyFromRuntimeController(deps, {
        ...args,
        paneSpawnOperation: operation
      })
      return freshResult
    }
  })
  if (!adopted) {
    return toRuntimeSpawnReply(freshResult!)
  }
  if (!args.worktreeId) {
    return toRuntimeSpawnReply(adopted.result)
  }
  const completed = await adoptMaterializedRuntimePtySpawn(
    createRuntimePtySpawnState(deps, { ...args, adoptedStablePane: adopted })
  )
  return toRuntimeSpawnReply(completed ?? adopted.result)
}

async function spawnFreshPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
) {
  const ctx = createRuntimePtySpawnState(deps, args)

  try {
    const materializedOrPromise = adoptMaterializedRuntimePtySpawn(ctx)
    const materialized =
      materializedOrPromise instanceof Promise ? await materializedOrPromise : materializedOrPromise
    if (materialized) {
      return toRuntimeSpawnReply(materialized)
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      return toRuntimeSpawnReply(earlyAdopt)
    }
    const earlyReserved = await buildRuntimePtySpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize({
        sessionId: ctx.sessionId,
        sessionAppId: ctx.effectiveSessionAppId,
        hadSessionSizeBeforeAttach: ctx.hadSessionSizeBeforeAttach,
        sessionSizeBeforeAttach: ctx.sessionSizeBeforeAttach
      })
      throw error
    })
    if (earlyReserved) {
      return toRuntimeSpawnReply(earlyReserved)
    }
    const complete = async (operation = args.paneSpawnOperation) => {
      ctx.args.paneSpawnOperation = operation
      await executeRuntimePtySpawn(ctx)
      const committed = await commitRuntimePtySpawn(ctx)
      commitRuntimeSpawnHiddenDelivery(ctx)
      return committed
    }
    const latePane =
      !args.paneSpawnOperation && ctx.spawnIdentityPaneKey
        ? parsePaneKey(ctx.spawnIdentityPaneKey)
        : null
    if (latePane) {
      ctx.args = { ...ctx.args, ...latePane }
      let result: Awaited<ReturnType<typeof complete>> | undefined
      const adopted = await deps.adoptStablePane({
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
        worktreeId: args.worktreeId,
        connectionId: args.connectionId,
        ...latePane,
        signal: args.signal,
        preAllocatedHandle: args.preAllocatedHandle,
        spawnFresh: async (operation) => (result = await complete(operation))
      })
      return toRuntimeSpawnReply(adopted?.result ?? result!)
    }
    return await complete()
  } catch (err) {
    releaseRuntimeSpawnPreSpawnHiddenMark(ctx)
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId,
        ctx.pendingRegistrationClaim
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Settle reservations on every post-reservation failure or future spawns for this pane wait forever.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
