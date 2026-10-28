/** Saved forwards that aren't open, why the last start failed, and when to try each again. */
import type { SavedPortForward, UnrestoredPortForward } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { portForwardManager } from './ssh-ipc-context'

type ForwardMapping = Pick<SavedPortForward, 'localPort' | 'remoteHost' | 'remotePort'>
type ForwardFailure = {
  message: string
  /** 'exit': it ran, then its process died; 'start': it never came up. */
  kind: 'start' | 'exit'
  attempts: number
  retryAt: number
  startedAt?: number
}

const FORWARD_RETRY_BASE_MS = 30_000
const FORWARD_RETRY_MAX_MS = 10 * 60_000
// A forward that stays up this long has recovered, so a later exit starts a fresh backoff.
const FORWARD_HEALTHY_MS = 5 * 60_000
const failuresByTarget = new Map<string, Map<string, ForwardFailure>>()

export function forwardKey(forward: ForwardMapping): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

/** A forward that keeps failing (port held, excluded range) backs off instead of retrying on every call. */
export function isForwardBackingOff(targetId: string, forward: ForwardMapping): boolean {
  const failure = failuresByTarget.get(targetId)?.get(forwardKey(forward))
  return failure !== undefined && failure.retryAt > Date.now()
}

export function recordForwardFailure(
  targetId: string,
  forward: ForwardMapping,
  error: unknown,
  kind: ForwardFailure['kind'] = 'start'
): void {
  let failures = failuresByTarget.get(targetId)
  if (!failures) {
    failures = new Map()
    failuresByTarget.set(targetId, failures)
  }
  const previous = failures.get(forwardKey(forward))
  const recovered =
    previous?.startedAt !== undefined && Date.now() - previous.startedAt >= FORWARD_HEALTHY_MS
  const attempts = (recovered ? 0 : (previous?.attempts ?? 0)) + 1
  failures.set(forwardKey(forward), {
    message: error instanceof Error ? error.message : String(error),
    kind,
    attempts,
    retryAt:
      Date.now() + Math.min(FORWARD_RETRY_BASE_MS * 2 ** (attempts - 1), FORWARD_RETRY_MAX_MS)
  })
}

/** A start keeps the failure streak until the forward has stayed up, so a flapping ssh keeps backing off. */
export function recordForwardStarted(targetId: string, forward: ForwardMapping): void {
  const failure = failuresByTarget.get(targetId)?.get(forwardKey(forward))
  if (failure) {
    failure.startedAt = Date.now()
  }
}

export function clearForwardFailure(targetId: string, forward: ForwardMapping): void {
  failuresByTarget.get(targetId)?.delete(forwardKey(forward))
}

export function forgetForwardFailures(targetId: string): void {
  failuresByTarget.delete(targetId)
}

/** Saved forwards with no live entry, so the user can see and remove one that can't start. */
export function listUnrestoredPortForwards(targetId: string): UnrestoredPortForward[] {
  const live = new Set(portForwardManager?.listForwards(targetId).map(forwardKey) ?? [])
  const saved = getSshTargetRegistryStore()?.getTarget(targetId)?.portForwards ?? []
  const failures = failuresByTarget.get(targetId)
  return saved
    .filter((forward) => !live.has(forwardKey(forward)))
    .map((forward) => {
      const failure = failures?.get(forwardKey(forward))
      return {
        ...forward,
        ...(failure ? { error: failure.message } : {}),
        ...(failure?.kind === 'exit' ? { stopped: true as const } : {})
      }
    })
}
