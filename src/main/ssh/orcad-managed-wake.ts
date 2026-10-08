/**
 * Starting a managed orcad that is installed and activated but not running, most often one
 * that stopped itself after idling. A stopped server is just "not running": it is neither a
 * failure nor evidence about terminals, which the daemon owns and which outlive orcad.
 */
import { ORCAD_FENCE_OWNER_FILENAME } from './orcad-activation-fence-scope'
import type { ServeReadiness } from '../server/serve-readiness'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { randomUUID } from 'node:crypto'
import {
  orcadActivationFenceExists,
  orcadActivationTransactionRoot,
  releaseOrcadActivationFence,
  withOrcadActivationLock
} from './orcad-activation-lock'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { joinRemotePath } from './ssh-remote-platform'

import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  slotLiveness,
  type OrcadSlotOptions
} from './orcad-recovery-slot'

export type OrcadManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  /** An update, rollback or recovery holds the host; it owns which slot serves. */
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }

/** Launches the active slot only on proven exit; a live or unprovable process is left alone. */
export function wakeStoppedManagedOrcad(
  options: OrcadSlotOptions,
  onStarting: () => void = () => {}
): Promise<OrcadManagedWake> {
  const host = wakeHostKey(options)
  // Registered before any remote step: a wake on a dropped connection settles first, so a
  // reconnected wake never races it to the fence and finds its fence unexplained.
  const prior = runningWakes.get(host)
  const wake = (async (): Promise<OrcadManagedWake> => {
    await prior?.catch(() => {})
    return wakeAfterPrior(options, host, onStarting)
  })()
  runningWakes.set(host, wake)
  void wake
    .catch(() => {})
    .finally(() => {
      if (runningWakes.get(host) === wake) {
        runningWakes.delete(host)
      }
    })
  return wake
}

async function wakeAfterPrior(
  options: OrcadSlotOptions,
  host: string,
  onStarting: () => void
): Promise<OrcadManagedWake> {
  const before = await readOrcadActivationRecord(options)
  if (!before.active) {
    return { outcome: 'not-activated' }
  }
  const liveness = await slotLiveness(options, orcadSlotDir(options, before.active))
  if (liveness !== 'DEAD') {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (!(await orcadActivationFenceExists(options))) {
    // The fence this client left is gone by some other route; any later one belongs to another run.
    interruptedWakes.delete(host)
  } else if (!(await releaseOwnInterruptedWakeFence(options, host))) {
    return { outcome: 'fenced' }
  }
  // Claimed before the fence and written by the command that creates it: a drop at any point
  // after the fence lands leaves one this client can prove its own. Kept on any failure, since a
  // release over a dropped connection fails quietly; the next wake re-proves it on the host.
  const token = randomUUID()
  interruptedWakes.set(host, token)
  const result = await withOrcadActivationLock(
    options,
    async (): Promise<OrcadManagedWake> => {
      // Re-read under the fence: another client may have activated or started a slot meanwhile.
      const active = (await readOrcadActivationRecord(options)).active
      if (!active) {
        return { outcome: 'not-activated' }
      }
      const identity = await resolveOrcadSlotIdentity(options, active)
      onStarting()
      return { outcome: 'started', readiness: await ensureOrcadSlotServing(options, identity) }
    },
    (): OrcadManagedWake => ({ outcome: 'fenced' }),
    token
  )
  // Released, or never acquired.
  if (interruptedWakes.get(host) === token) {
    interruptedWakes.delete(host)
  }
  return result
}

const runningWakes = new Map<string, Promise<OrcadManagedWake>>()

// The owner token of a fence this client's own wake may have left when its connection dropped.
const interruptedWakes = new Map<string, string>()

function wakeOwnerPath(options: OrcadSlotOptions): string {
  return joinRemotePath(
    options.host,
    orcadActivationTransactionRoot(options.host, options.remoteHome),
    RELAY_INSTALL_LOCK_NAME,
    ORCAD_FENCE_OWNER_FILENAME
  )
}

function wakeHostKey(options: OrcadSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/**
 * Releases only the fence carrying this client's own interrupted wake token and no journal; the
 * slot was just proven exited and orcad's instance lock bars a double start.
 */
async function releaseOwnInterruptedWakeFence(
  options: OrcadSlotOptions,
  host: string
): Promise<boolean> {
  const token = interruptedWakes.get(host)
  if (!token || (await readOrcadActivationTransaction(options))) {
    return false
  }
  // Only a fence carrying this process's own token: a fresh fence another client took has none yet.
  const owner = await readBoundedOrcadRemoteRecord(options, wakeOwnerPath(options), 64)
  if (owner.state !== 'present' || owner.raw.trim() !== token) {
    interruptedWakes.delete(host)
    return false
  }
  await releaseOrcadActivationFence(options, token)
  interruptedWakes.delete(host)
  return true
}
