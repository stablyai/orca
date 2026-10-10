/**
 * A host another desktop was updating answers this one with "holds this host" or a fence-busy
 * deferral. That clears within minutes, but this connect's status would keep it until the next
 * reconnect; so the connect checks again on a timer until the host answers without the fence.
 */
import type { SshTarget } from '../../shared/ssh-types'
import { checkManagedServerUpdate } from './managed-server-update-check'
import { managedResultAfterUpdate, unservedManagedResult } from './managed-server-serving-gate'
import type {
  HostServerOnConnectDeps,
  HostServerOnConnectResult
} from './ssh-host-server-on-connect'

type ManagedResult = Extract<HostServerOnConnectResult, { route: 'managed' }>

export const FENCE_RECHECK_INTERVAL_MS = 45_000
// About half an hour: past the 20-minute stale install lock a crashed updater can leave.
const FENCE_RECHECK_MAX_ATTEMPTS = 40

/** The connect's serving check and update check again, without its progress statuses. */
export async function recheckFencedManagedServer(
  target: SshTarget,
  environmentId: string,
  deps: Pick<HostServerOnConnectDeps, 'ensureServing'> &
    Parameters<typeof checkManagedServerUpdate>[2]
): Promise<ManagedResult> {
  const serving = await deps.ensureServing(environmentId)
  const unserved = unservedManagedResult(environmentId, serving)
  if (unserved) {
    return unserved
  }
  const update = await checkManagedServerUpdate(target, environmentId, deps, () => {})
  return managedResultAfterUpdate(environmentId, serving, update)
}

export type FenceRecheckLoop = {
  /** False once the host disconnected, or another connect replaced this one's status. */
  stillCurrent: () => boolean
  recheck: () => Promise<ManagedResult>
  publish: (result: ManagedResult) => void
  intervalMs?: number
}

const loops = new Map<string, () => void>()

/** Replaces any loop for the target; publishes the first answer free of the fence, then stops. */
export function scheduleManagedServerFenceRecheck(targetId: string, loop: FenceRecheckLoop): void {
  loops.get(targetId)?.()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const stop = (): void => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
    if (loops.get(targetId) === stop) {
      loops.delete(targetId)
    }
  }
  loops.set(targetId, stop)
  const tick = async (attempt: number): Promise<void> => {
    if (stopped || !loop.stillCurrent()) {
      stop()
      return
    }
    const result = await loop.recheck().catch((error: unknown) => {
      console.warn('[ssh] Could not recheck the managed Orca server:', error)
      return null
    })
    if (stopped || !loop.stillCurrent()) {
      stop()
      return
    }
    if (result && !result.fenceHeld) {
      stop()
      loop.publish(result)
      return
    }
    if (attempt + 1 >= FENCE_RECHECK_MAX_ATTEMPTS) {
      stop()
      return
    }
    timer = setTimeout(() => void tick(attempt + 1), loop.intervalMs ?? FENCE_RECHECK_INTERVAL_MS)
  }
  timer = setTimeout(() => void tick(0), loop.intervalMs ?? FENCE_RECHECK_INTERVAL_MS)
}

export function cancelManagedServerFenceRecheck(targetId: string): void {
  loops.get(targetId)?.()
}
