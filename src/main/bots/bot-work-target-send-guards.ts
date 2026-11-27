import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationEntryCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { FederatedDispatchRow } from '../runtime/orchestration/db/orchestration-records'
import {
  activeBotWorkTargetForCaller,
  workTargetProvenanceOriginForCaller
} from './bot-turn-work-target'
import {
  verifyBareRecipientMatchesWorkTarget,
  verifyLegacyFederatedWorkTarget,
  verifyLocalWorkerDispatchMatchesWorkTarget
} from './bot-work-target-follow-up'
import {
  isWorkTargetFollowUpMessageType,
  workTargetFollowUpRefusal
} from './bot-work-target-registration-checks'

export type SendWorkTargetGuardRuntime = Pick<
  OrcaRuntimeService,
  | 'botWorkTargets'
  | 'showManagedTerminalWorkspace'
  | 'getBotWorkTargetCatalogStore'
  | 'showTerminal'
  | 'getOrchestrationDispatchAuthority'
  | 'resolveOrchestrationWorkerServer'
>

export type SendWorkTargetGuard = {
  placement: ResolvedBotWorkTargetPlacement
  origin: string
  provenanceFor: (
    to: string
  ) => { sourceOrigin: string; placement: ResolvedBotWorkTargetPlacement } | undefined
  verifyDirect: (db: OrchestrationDb, to: string, rawRecipient: string) => Promise<void>
  verifyGroup: (
    db: OrchestrationDb,
    recipients: readonly { to: string }[],
    candidates: readonly { handle: string; mailbox?: { to: string } }[]
  ) => Promise<void>
}

/** Build a compact active-turn work-target guard for follow-up send types, or undefined when inactive. */
export function resolveSendWorkTargetGuard(
  runtime: SendWorkTargetGuardRuntime,
  caller: OrchestrationEntryCaller | undefined,
  from: string,
  type: string | undefined
): SendWorkTargetGuard | undefined {
  if (!isWorkTargetFollowUpMessageType(type)) {
    return undefined
  }
  const placement = activeBotWorkTargetForCaller(runtime.botWorkTargets, caller)
  if (!placement) {
    return undefined
  }
  const origin = workTargetProvenanceOriginForCaller(caller, from)
  return {
    placement,
    origin,
    provenanceFor: (to) =>
      to.startsWith('run:') ? undefined : { sourceOrigin: origin, placement },
    verifyDirect: (db, to, rawRecipient) => {
      const addressedDispatchId = to.startsWith('dispatch:')
        ? to.slice('dispatch:'.length)
        : undefined
      const federatedTarget =
        addressedDispatchId && to === `dispatch:${addressedDispatchId}`
          ? db.getFederatedDispatch(addressedDispatchId)
          : undefined
      return verifySendFollowUpWorkTarget({
        runtime,
        db,
        to,
        rawRecipient,
        addressedDispatchId,
        federatedTarget,
        workTarget: placement
      })
    },
    verifyGroup: (db, recipients, candidates) =>
      verifyGroupSendWorkTarget({ runtime, db, recipients, candidates, workTarget: placement })
  }
}

/** Enforce active turn target on a point-to-point `orchestration.send` recipient before any effects. */
export async function verifySendFollowUpWorkTarget(args: {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showManagedTerminalWorkspace'
    | 'getBotWorkTargetCatalogStore'
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
    | 'resolveOrchestrationWorkerServer'
  >
  db: OrchestrationDb
  to: string
  rawRecipient: string
  addressedDispatchId: string | undefined
  federatedTarget: FederatedDispatchRow | undefined
  workTarget: ResolvedBotWorkTargetPlacement
}): Promise<void> {
  const { runtime, db, to, rawRecipient, addressedDispatchId, federatedTarget, workTarget } = args
  if (addressedDispatchId && !federatedTarget) {
    await verifyLocalWorkerDispatchMatchesWorkTarget(runtime, db, addressedDispatchId, workTarget)
  } else if (addressedDispatchId && federatedTarget) {
    await verifyLegacyFederatedWorkTarget(runtime, federatedTarget, workTarget)
  } else if (!to.startsWith('run:')) {
    await verifyBareRecipientMatchesWorkTarget(runtime, to, workTarget)
  } else if (!rawRecipient.startsWith('run:')) {
    await verifyBareRecipientMatchesWorkTarget(runtime, rawRecipient, workTarget)
  }
}

/** Enforce active turn target across every resolved group fan-out recipient before storing mail. */
export async function verifyGroupSendWorkTarget(args: {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showManagedTerminalWorkspace'
    | 'getBotWorkTargetCatalogStore'
    | 'showTerminal'
    | 'getOrchestrationDispatchAuthority'
  >
  db: OrchestrationDb
  recipients: readonly { to: string }[]
  candidates: readonly { handle: string; mailbox?: { to: string } }[]
  workTarget: ResolvedBotWorkTargetPlacement
}): Promise<void> {
  const { runtime, db, recipients, candidates, workTarget } = args
  for (const resolution of recipients) {
    if (resolution.to.startsWith('dispatch:')) {
      await verifyLocalWorkerDispatchMatchesWorkTarget(
        runtime,
        db,
        resolution.to.slice('dispatch:'.length),
        workTarget
      )
    } else if (resolution.to.startsWith('run:')) {
      const candidate = candidates.find((entry) => entry.mailbox?.to === resolution.to)
      if (!candidate) {
        throw workTargetFollowUpRefusal(
          workTarget,
          `Cannot verify group recipient ${resolution.to} against the selected target.`
        )
      }
      await verifyBareRecipientMatchesWorkTarget(runtime, candidate.handle, workTarget)
    } else {
      await verifyBareRecipientMatchesWorkTarget(runtime, resolution.to, workTarget)
    }
  }
}
