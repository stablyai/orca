import { setTimeout as delay } from 'node:timers/promises'
import type { OrcaCloudAuthConfig } from './cloud-auth/profile-cloud-auth-config'
import {
  pollServerSignInRequest,
  ServerSignInRequestRetryableError,
  type ServerSignInRequest
} from './orca-cloud-server-sign-in-requests'

export const ACCOUNT_CHANGED = 'The account on this host changed during sign-in. Start again.'
const SLOW_DOWN_STEP_MS = 5_000
const MIN_INTERVAL_MS = 1_000
const MAX_BACKOFF_MS = 60_000

export type ServerSignInApprovalDeps = {
  poll?: typeof pollServerSignInRequest
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

/** Asks Orca Cloud whether the person approved, at the pace it sets, until a code, a refusal,
 * expiry, or `signal`. Network trouble and 5xx answers back off and keep asking. */
export async function awaitServerSignInApproval(args: {
  config: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>
  request: ServerSignInRequest
  signal: AbortSignal
  /** True once something else (a profile switch, another sign-in) made this one moot. */
  isSuperseded: () => boolean
  deps?: ServerSignInApprovalDeps
}): Promise<{ code: string; redirectUri: string }> {
  const { config, request, signal, isSuperseded, deps = {} } = args
  const poll = deps.poll ?? pollServerSignInRequest
  const sleep = deps.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }))
  const now = deps.now ?? Date.now
  const deadline = now() + request.expiresInSeconds * 1000
  let interval = Math.max(request.intervalSeconds * 1000, MIN_INTERVAL_MS)
  let wait = interval
  let failures = 0
  const assertStillWanted = (): void => {
    signal.throwIfAborted()
    if (isSuperseded()) {
      throw new Error(ACCOUNT_CHANGED)
    }
    if (now() >= deadline) {
      throw new Error('This sign-in expired. Start it again.')
    }
  }
  for (;;) {
    await sleep(Math.min(wait, Math.max(deadline - now(), 0)), signal)
    assertStillWanted()
    let result: Awaited<ReturnType<typeof poll>>
    try {
      result = await poll(config, request, signal)
      // An answer that arrives after a cancel, sign-out or the deadline is stale, approved or not.
      assertStillWanted()
    } catch (error) {
      if (!(error instanceof ServerSignInRequestRetryableError) || signal.aborted) {
        throw error
      }
      failures++
      wait = Math.min(interval * 2 ** failures, MAX_BACKOFF_MS)
      continue
    }
    failures = 0
    switch (result.status) {
      case 'approved':
        return { code: result.code, redirectUri: result.redirectUri }
      case 'denied':
        throw new Error('The sign-in was declined in the browser.')
      case 'expired':
        // Also what a poll after the code was claimed reads.
        throw new Error('This sign-in expired. Start it again.')
      case 'slow_down':
        interval = Math.max(interval + SLOW_DOWN_STEP_MS, (result.intervalSeconds ?? 0) * 1000)
        break
      case 'pending':
        break
    }
    wait = interval
  }
}
