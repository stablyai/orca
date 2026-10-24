// Orcad exit does not prove terminal exit: the terminal daemon can outlive the server.
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import type { ServeReadiness } from '../../server/serve-readiness'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { randomUUID } from 'node:crypto'
import {
  orcadActivationFenceExists,
  releaseOrcadActivationFence,
  withOrcadActivationLock
} from '../activation/orcad-activation-lock'
import { orcadLivenessProvenExited } from '../install/orcad-remote-launch'
import { readBoundedOrcadRemoteRecord } from '../install/orcad-remote-record-file'
import { orcadActivationFenceLockDir } from '../activation/orcad-activation-transaction'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'

import { readOrcadActivationTransaction } from '../activation/orcad-activation-transaction-store'
import {
  ORCAD_RECOVERY_UNVERIFIABLE_CODE,
  recoverInterruptedOrcadActivation
} from '../activation/orcad-activation-recovery'
import {
  ensureOrcadSlotServing,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  slotLiveness,
  type OrcadSlotOptions
} from '../../ssh/orcad-recovery-slot'

type OrcadManagedWake =
  | { outcome: 'serving' | 'not-activated' | 'unverifiable' }
  | { outcome: 'fenced' }
  | { outcome: 'started'; readiness: ServeReadiness }
  | { outcome: 'recovery-refused'; reason: string }

/** Start only proven-stopped active slots; leave live or unverifiable processes alone. */
export function wakeStoppedManagedOrcad(
  options: OrcadSlotOptions,
  onStarting: () => void = () => {}
): Promise<OrcadManagedWake> {
  const host = wakeHostKey(options)
  // Serialize per host before remote work so reconnect cannot race an earlier wake's unexplained fence.
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
  if (!orcadLivenessProvenExited(liveness)) {
    return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
  }
  if (!(await orcadActivationFenceExists(options))) {
    interruptedWakes.delete(host)
  } else if (!(await releaseOwnInterruptedWakeFence(options, host))) {
    const recovered = await recoverAbandonedFence(options, onStarting)
    if (recovered) {
      return recovered
    }
  }
  // Record ownership before acquisition: dropped replies can leave fences only this token can reclaim.
  const token = randomUUID()
  interruptedWakes.set(host, token)
  const result = await withOrcadActivationLock(
    options,
    async (): Promise<OrcadManagedWake> => {
      // Other clients may change the active slot; reread under the fence.
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
  if (interruptedWakes.get(host) === token) {
    interruptedWakes.delete(host)
  }
  return result
}

/** Recover abandoned journals under stale, previous-boot or proven-exited fences; busy runs retain ownership. */
async function recoverAbandonedFence(
  options: OrcadSlotOptions,
  onStarting: () => void
): Promise<OrcadManagedWake | null> {
  const recovery = await recoverInterruptedOrcadActivation(options)
  switch (recovery.outcome) {
    case 'none':
      return null
    case 'pending':
      return { outcome: 'fenced' }
    case 'refused':
      // Retry unverifiable recovery at the next fence check, as with a busy owner.
      return recovery.code === ORCAD_RECOVERY_UNVERIFIABLE_CODE
        ? { outcome: 'fenced' }
        : { outcome: 'recovery-refused', reason: recovery.reason }
    case 'recovered':
      if (!recovery.readiness) {
        return { outcome: 'not-activated' }
      }
      onStarting()
      return { outcome: 'started', readiness: recovery.readiness }
  }
}

const runningWakes = new Map<string, Promise<OrcadManagedWake>>()

const interruptedWakes = new Map<string, string>()

function wakeOwnerPath(options: OrcadSlotOptions): string {
  return joinRemotePath(
    options.host,
    orcadActivationFenceLockDir(options.host, options.remoteHome),
    ORCAD_FENCE_OWNER_FILENAME
  )
}

function wakeHostKey(options: OrcadSlotOptions): string {
  return `${options.conn.getTarget().id}\0${options.remoteHome}`
}

/** Reclaim only this client's journal-free interrupted fence after proving slot exit. */
async function releaseOwnInterruptedWakeFence(
  options: OrcadSlotOptions,
  host: string
): Promise<boolean> {
  const token = interruptedWakes.get(host)
  if (!token || (await readOrcadActivationTransaction(options))) {
    return false
  }
  // A new owner may not have written its token yet; absence cannot prove this fence ours.
  const owner = await readBoundedOrcadRemoteRecord(options, wakeOwnerPath(options), 64)
  if (owner.state !== 'present' || owner.raw.trim() !== token) {
    interruptedWakes.delete(host)
    return false
  }
  await releaseOrcadActivationFence(options, token)
  interruptedWakes.delete(host)
  return true
}
