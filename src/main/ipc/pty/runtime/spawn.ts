import {
  captureSavedResumeCleanup,
  admitColdRestoreReattach,
  savedResumeRecord,
  savedResumeResult,
  resumeSpawnRefusal,
  forgetRefusedResume
} from '../host-env/saved-resume-admission'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
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

function toRuntimeSpawnReply(
  result: PtySpawnResult & {
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    savedStartupCwd?: string
  }
) {
  return { ...result, wslDistro: result.wslDistro ?? undefined }
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
  Object.assign(adopted.result, deps.runtime?.getTerminalLaunchResult?.(adopted.result.id))
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
      return { ...materialized, ...deps.runtime?.getTerminalLaunchResult?.(materialized.id) }
    }
    const earlyAdopt = await prepareRuntimePtySpawn(ctx)
    if (earlyAdopt) {
      return { ...earlyAdopt, ...deps.runtime?.getTerminalLaunchResult?.(earlyAdopt.id) }
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
      return { ...earlyReserved, ...deps.runtime?.getTerminalLaunchResult?.(earlyReserved.id) }
    }
    const complete = async (operation = args.paneSpawnOperation) => {
      ctx.args.paneSpawnOperation = operation
      await executeRuntimePtySpawn(ctx)
      if (!ctx.resumeAdmission) {
        ctx.resumeAdmission = await admitColdRestoreReattach(
          deps.runtime,
          ctx.result,
          {
            paneKey: ctx.spawnIdentityPaneKey,
            saved: savedResumeRecord(deps.store, ctx.spawnIdentityPaneKey)
          },
          ctx.expectedWslDistro
        )
        await captureSavedResumeCleanup(
          deps.runtime,
          deps.store,
          ctx.spawnIdentityPaneKey,
          ctx.resumeAdmission,
          args.worktreeId
        )
      }
      if (!ctx.result.isReattach) {
        Object.assign(ctx.result, savedResumeResult(ctx.resumeAdmission), {
          ...(ctx.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
          launchConfig: args.launchConfig,
          launchAgent: args.launchAgent,
          launchToken: args.launchToken,
          resumeProviderSession: ctx.codexResumeArgvDropped ? undefined : args.resumeProviderSession
        })
      }
      const committed = await commitRuntimePtySpawn(ctx)
      const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
      forgetRefusedResume(ctx.spawnIdentityPaneKey, refusal)
      if (
        args.worktreeId &&
        ctx.spawnIdentityPaneKey &&
        refusal &&
        refusal.verdict !== 'unverifiable'
      ) {
        void deps.runtime
          ?.forgetRefusedSavedResume?.(
            args.worktreeId,
            ctx.spawnIdentityPaneKey,
            refusal.refused,
            refusal.sourceRecord
          )
          .catch((error: unknown) => console.warn('[pty] refused resume cleanup failed', error))
      }
      commitRuntimeSpawnHiddenDelivery(ctx)
      if (!ctx.result.isReattach) {
        deps.runtime?.rememberSavedTerminalLaunchResult?.(committed.id, committed)
      }
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
      if (adopted) {
        Object.assign(adopted.result, deps.runtime?.getTerminalLaunchResult?.(adopted.result.id))
      }
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
