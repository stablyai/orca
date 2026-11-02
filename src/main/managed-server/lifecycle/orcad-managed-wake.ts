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
  return serializedWake(options, (host) => wakeAfterPrior(options, host, onStarting))
}

/**
 * WSL's same-version connect: one fence both confirms `expectActive` is still the active slot
 * and starts it if proven stopped. 'replan' means another version is active now; 'fenced' that
 * the fence was busy. Either way the caller takes the full deploy and wake.
 */
export function wakeExpectedOrcadUnderOneFence(
  options: OrcadSlotOptions,
  expectActive: string
): Promise<OrcadManagedWake | { outcome: 'replan' }> {
  return serializedWake(options, async (host) => {
    // An earlier wake's dropped fence is reclaimed only by the full wake, which knows its token.
    if (interruptedWakes.has(host)) {
      return { outcome: 'fenced' }
    }
    // Record ownership before acquisition, as the wake does: a dropped reply leaves a fence only it can reclaim.
    const token = randomUUID()
    interruptedWakes.set(host, token)
    const result = await withOrcadActivationLock(
      options,
      async (): Promise<OrcadManagedWake | { outcome: 'replan' }> => {
        if ((await readOrcadActivationRecord(options)).active !== expectActive) {
          return { outcome: 'replan' }
        }
        const liveness = await slotLiveness(options, orcadSlotDir(options, expectActive))
        if (!orcadLivenessProvenExited(liveness)) {
          return { outcome: liveness === 'LIVE' ? 'serving' : 'unverifiable' }
        }
        const identity = await resolveOrcadSlotIdentity(options, expectActive)
        return { outcome: 'started', readiness: await ensureOrcadSlotServing(options, identity) }
      },
      (): OrcadManagedWake => ({ outcome: 'fenced' }),
      token
    )
    if (interruptedWakes.get(host) === token) {
      interruptedWakes.delete(host)
    }
    return result
  })
}

function serializedWake<T>(
  options: OrcadSlotOptions,
  run: (host: string) => Promise<T>
): Promise<T> {
  const host = wakeHostKey(options)
  // Serialize per host before remote work so reconnect cannot race an earlier wake's unexplained fence.
  const prior = runningWakes.get(host)
  const wake = (async (): Promise<T> => {
    await prior?.catch(() => {})
    return run(host)
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
    await forgetSettledInterruptedWake(options, host, liveness === 'LIVE')
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

const runningWakes = new Map<string, Promise<unknown>>()

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

/**
 * A serving slot skips the fence branch that clears an interrupted wake's token, which would
 * keep the one-fence wake off until restart. Forget it once its fence is gone or another owner's;
 * an unanswered probe proves neither, so the token stays. A fence still ours whose dropped launch
 * did start the slot (proven LIVE, no journal) is released, or deploys would wait for it to age out.
 */
async function forgetSettledInterruptedWake(
  options: OrcadSlotOptions,
  host: string,
  slotLive: boolean
): Promise<void> {
  const token = interruptedWakes.get(host)
  if (!token) {
    return
  }
  try {
    const owner = (await orcadActivationFenceExists(options))
      ? await readBoundedOrcadRemoteRecord(options, wakeOwnerPath(options), 64)
      : null
    const ours = owner?.state === 'present' && owner.raw.trim() === token
    if (ours && slotLive && !(await readOrcadActivationTransaction(options))) {
      // The release command re-proves the owner token on the host before removing anything.
      await releaseOrcadActivationFence(options, token)
    } else if (ours || owner?.state === 'absent') {
      return
    }
    if (interruptedWakes.get(host) === token) {
      interruptedWakes.delete(host)
    }
  } catch {
    // Unverifiable: keep the token for the next wake.
  }
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
