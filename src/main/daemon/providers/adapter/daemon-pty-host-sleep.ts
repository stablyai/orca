import type { DaemonClient } from '../../transport/client/daemon-client'
import type { SessionInfo } from '../../protocol/daemon-session-info'
import type { DaemonPtyHostHistoryBindings, HostHistoryBinding } from './daemon-pty-host-history'
import type {
  DaemonPtyInventoryObservation,
  InventoryRequest
} from './daemon-pty-inventory-observation'
import { FinalCheckpointWaitExpiredError } from './daemon-pty-lifecycle-errors'

/** The exact binding a keep-history Sleep began with, and the inventory observation since. */
export type HostSleepTarget = {
  binding: HostHistoryBinding | undefined
  observation: InventoryRequest
}

/**
 * Host Sleep of the binding it began with: a same-ID spawn, exit, reconnect or newer binding
 * before dispatch refuses it; it never probes, finalizes or kills a successor instead.
 * Returns the finalized incarnation.
 */
export async function sleepHostTarget(
  id: string,
  target: HostSleepTarget | undefined,
  deps: {
    client: DaemonClient
    bindings: DaemonPtyHostHistoryBindings
    inventory: DaemonPtyInventoryObservation
    probeFolder: () => Promise<string | null>
  },
  opts: { immediate?: boolean; deadlineMs?: number }
): Promise<string> {
  const binding = target ? target.binding : deps.bindings.get(id)
  const applies = (): boolean =>
    !target ||
    (deps.bindings.get(id) === target.binding &&
      deps.inventory.stillApplies(target.observation, id, target.binding?.incarnationId))
  if (!binding?.incarnationId || !applies()) {
    throw new FinalCheckpointWaitExpiredError(id)
  }
  const cwd = await deps.probeFolder()
  if (!applies()) {
    throw new FinalCheckpointWaitExpiredError(id)
  }
  // The daemon ends this exact process itself; no second kill, no main readback.
  const slept = await deps.bindings.finalizeSleep(deps.client, id, binding, { ...opts, cwd })
  if (!slept) {
    throw new FinalCheckpointWaitExpiredError(id)
  }
  return slept
}

/** A surviving host session gets its exact binding, so quit commits it even if never mounted. */
export function bindListedHostSession(
  bindings: DaemonPtyHostHistoryBindings,
  inventory: DaemonPtyInventoryObservation,
  observation: InventoryRequest,
  session: SessionInfo
): void {
  const current = bindings.get(session.sessionId)
  if (
    !bindings.enabled ||
    !session.incarnationId ||
    current?.incarnationId ||
    !inventory.stillApplies(observation, session.sessionId, session.incarnationId)
  ) {
    return
  }
  // Same admission as any binding already there, so binding releases no claim.
  bindings.bind(session.sessionId, {
    incarnationId: session.incarnationId,
    admission: current?.admission,
    outcome: current?.outcome
  })
}
