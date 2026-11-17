import { recipeVmWakeIntentFor } from '../../../../shared/remote-runtime/recipe-vm-wake'
import { getRecipeVmWaker } from '../../../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { latestRecipeVmWake } from '../../../ephemeral-vm/recipe-vm-wake-pairings'
import { recipeVmOf, type RecipeVmEnvironment } from './runtime-environment-recipe-vm-wake'

/** How long a request that does not open the workspace waits for a wake already in flight. */
export const RECIPE_VM_IN_FLIGHT_WAKE_HOLD_MS = 60_000

/**
 * Before a request that does not open the workspace takes its call slot: while the VM's wake is
 * already underway (often just reconnecting), wait for it, up to `holdMs`, instead of being refused
 * and never retried. Never starts a wake and never refuses: the request's own preparation decides
 * what happens next (it is refused there if the wake failed or is still running).
 */
export async function awaitRecipeVmInFlightWake<E extends RecipeVmEnvironment>(
  userDataPath: string,
  environment: E,
  holdMs: number,
  signal?: AbortSignal
): Promise<HeldRecipeVmWake<E> | null> {
  const waker = getRecipeVmWaker()
  if (holdMs <= 0 || !waker?.awaitWake) {
    return null
  }
  const vm = recipeVmOf(userDataPath, environment)
  if (!vm || waker.state(vm.workspaceId, vm.recordSuspended) !== 'waking') {
    return null
  }
  const before = latestRecipeVmWake(environment.id)
  await waker.awaitWake(vm.workspaceId, vm.recordSuspended, holdMs, signal).catch(() => undefined)
  const woken = latestRecipeVmWake(environment.id)
  // The wake this request waited through re-paired the server: the caller's fence names the pairing
  // before it, exactly as for a request that woke the VM itself.
  return woken !== before
    ? { before: environment, wokenPairingRevision: woken?.pairingRevision ?? null }
    : null
}

/** A wake a request waited through before taking its call slot: the record from before it and
 *  the pairing it left. */
export type HeldRecipeVmWake<E = RecipeVmEnvironment> = {
  before: E
  wokenPairingRevision: number | null
}

/**
 * A request that does not open the workspace waits for a wake already in flight (bounded by the
 * in-flight hold and its caller's preparation), then gets its own timeout once dispatched. Not
 * bounded by that call timeout: a wake slower than it would refuse every request made meanwhile,
 * and several (terminal.resolvePane, session.tabs.activate, the pane layout) are not retried, which
 * left the woken pane dead. A caller that gives up aborts its signal, which ends the hold. Called
 * before the request takes a per-environment call slot, so held requests never block an open.
 */
export function holdForInFlightRecipeVmWake<E extends RecipeVmEnvironment>(
  userDataPath: string,
  environment: E,
  method: string,
  options?: { preparation?: { recipeVmHoldMs?: number }; signal?: AbortSignal }
): Promise<HeldRecipeVmWake<E> | null> {
  if (recipeVmWakeIntentFor(method) !== 'none') {
    return Promise.resolve(null)
  }
  const holdMs = Math.min(
    RECIPE_VM_IN_FLIGHT_WAKE_HOLD_MS,
    options?.preparation?.recipeVmHoldMs ?? Infinity
  )
  return awaitRecipeVmInFlightWake(userDataPath, environment, holdMs, options?.signal)
}
