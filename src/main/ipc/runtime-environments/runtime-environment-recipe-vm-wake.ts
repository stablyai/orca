import {
  findEnvironmentEphemeralVmRuntime,
  isEphemeralVmSuspended
} from '../../../shared/ephemeral-vm-environment-sleep'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  RECIPE_VM_OPEN_HOLD_MS,
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE,
  RUNTIME_ENVIRONMENT_SLEPT_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKE_FAILED_ERROR_CODE,
  RUNTIME_ENVIRONMENT_WAKE_FAILED_MESSAGE,
  RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
  RUNTIME_ENVIRONMENT_WAKING_MESSAGE,
  recipeVmWakeIntentFor,
  type RecipeVmWakeIntent
} from '../../../shared/remote-runtime/recipe-vm-wake'
import { getRecipeVmWaker } from '../../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { latestRecipeVmWake } from '../../ephemeral-vm/recipe-vm-wake-pairings'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  runtimeEnvironmentManualDisconnectCount,
  runtimeEnvironmentManualDisconnectReason
} from './runtime-environment-manual-disconnect'
import type {
  RecipeVmOpening,
  RecipeVmState
} from '../../runtime/workspaces/sleep/recipe-vm-operations'

type RecipeVmEnvironment = Pick<KnownRuntimeEnvironment, 'id' | 'source' | 'orcadDeployment'>

/** The workspace and stored state of the live recipe VM serving this environment. */
function recipeVmOf(
  userDataPath: string,
  environment: RecipeVmEnvironment
): { workspaceId: string; recordSuspended: boolean } | null {
  const vm = findEnvironmentEphemeralVmRuntime(userDataPath, environment)
  return vm ? { workspaceId: vm.workspaceId, recordSuspended: isEphemeralVmSuspended(vm) } : null
}

/** Where the recipe VM behind a phone link's server stands, for a request that opens a workspace
 *  on that link: only while it is up may the link carry it (the server is otherwise going or
 *  gone), and then the open counts as a reopening, so a sleep on its way leaves the VM up. */
export function recipeVmServerState(userDataPath: string, environmentId: string): RecipeVmState {
  let environment: RecipeVmEnvironment
  try {
    environment = resolveEnvironment(userDataPath, environmentId)
  } catch {
    return 'up'
  }
  const vm = recipeVmOf(userDataPath, environment)
  const waker = getRecipeVmWaker()
  if (!vm || !waker) {
    return 'up'
  }
  const state = waker.state(vm.workspaceId, vm.recordSuspended)
  if (state === 'up') {
    waker.noteOpened(vm.workspaceId)
  }
  return state
}

/**
 * Before dialing a recipe VM's server. The host holds a request that opens the workspace until
 * the VM is up (waking it if needed), so every client's open just works; it answers waking or
 * failed only when the hold runs out or the wake fails, and asleep when a later Sleep won. Any
 * other request learns the VM is waking or asleep instead of waiting out a connect to nothing.
 */
export async function prepareRecipeVm(
  userDataPath: string,
  environment: RecipeVmEnvironment,
  intent: RecipeVmWakeIntent,
  holdMs = RECIPE_VM_OPEN_HOLD_MS,
  signal?: AbortSignal
): Promise<RecipeVmPreparation> {
  const vm = recipeVmOf(userDataPath, environment)
  if (!vm) {
    return UNCHANGED
  }
  const waker = getRecipeVmWaker()
  if (!waker) {
    if (vm.recordSuspended) {
      throw refusal('asleep')
    }
    return UNCHANGED
  }
  if (intent === 'wake') {
    // A server the user disconnected stays down: no client's open wakes its VM.
    if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      throw new RemoteRuntimeClientError(
        'runtime_manually_disconnected',
        runtimeEnvironmentManualDisconnectReason(environment.id)
      )
    }
    const wakeBefore = latestRecipeVmWake(environment.id)
    const disconnectsBefore = runtimeEnvironmentManualDisconnectCount(environment.id)
    const opening = await waker.holdOpen(vm.workspaceId, vm.recordSuspended, holdMs, signal)
    if (opening !== 'up') {
      throw refusal(opening)
    }
    // A Disconnect while the open waited cancels the open; the VM's resume goes on.
    if (runtimeEnvironmentManualDisconnectCount(environment.id) !== disconnectsBefore) {
      throw new RemoteRuntimeClientError(
        'runtime_manually_disconnected',
        runtimeEnvironmentManualDisconnectReason(environment.id)
      )
    }
    // A wake that ran while this request waited left the server on this exact pairing.
    const woken = latestRecipeVmWake(environment.id)
    return { wokenPairingRevision: woken !== wakeBefore ? (woken?.pairingRevision ?? null) : null }
  }
  const state = waker.state(vm.workspaceId, vm.recordSuspended)
  if (state !== 'up') {
    throw refusal(state)
  }
  return UNCHANGED
}

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

/** The pairing revision a recipe VM wake this request waited for left its server on, if any. */
export type RecipeVmPreparation = { wokenPairingRevision: number | null }
const UNCHANGED: RecipeVmPreparation = { wokenPairingRevision: null }

/** Holds the CLI's open of the workspace behind an environment until its VM is up; throws the
 *  refusal a client would get otherwise. */
export async function openRecipeVmEnvironment(
  userDataPath: string,
  environment: RecipeVmEnvironment
): Promise<RecipeVmOpening> {
  await prepareRecipeVm(userDataPath, environment, 'wake')
  return 'up'
}

function refusal(outcome: Exclude<RecipeVmOpening, 'up'> | 'asleep'): RemoteRuntimeClientError {
  switch (outcome) {
    case 'waking':
      return new RemoteRuntimeClientError(
        RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
        RUNTIME_ENVIRONMENT_WAKING_MESSAGE
      )
    case 'wake-failed':
      return new RemoteRuntimeClientError(
        RUNTIME_ENVIRONMENT_WAKE_FAILED_ERROR_CODE,
        RUNTIME_ENVIRONMENT_WAKE_FAILED_MESSAGE
      )
    case 'slept':
      return new RemoteRuntimeClientError(
        RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
        RUNTIME_ENVIRONMENT_SLEPT_MESSAGE
      )
    case 'asleep':
      return new RemoteRuntimeClientError(
        RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
        RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
      )
  }
}

/** A request that does not open the workspace waits (bounded by its own timeout and hold) for a wake
 *  already in flight. Called before the request takes a per-environment call slot, so held
 *  background requests never block an open. */
export function holdForInFlightRecipeVmWake<E extends RecipeVmEnvironment>(
  userDataPath: string,
  environment: E,
  method: string,
  timeoutMs: number | undefined,
  options?: { preparation?: { recipeVmHoldMs?: number }; signal?: AbortSignal }
): Promise<HeldRecipeVmWake<E> | null> {
  if (recipeVmWakeIntentFor(method) !== 'none') {
    return Promise.resolve(null)
  }
  const holdMs = Math.min(
    RECIPE_VM_IN_FLIGHT_WAKE_HOLD_MS,
    options?.preparation?.recipeVmHoldMs ?? Infinity,
    timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  )
  return awaitRecipeVmInFlightWake(userDataPath, environment, holdMs, options?.signal)
}

/** The transport's default call timeout, which also bounds the hold for calls that set none. */
const DEFAULT_CALL_TIMEOUT_MS = 15_000
