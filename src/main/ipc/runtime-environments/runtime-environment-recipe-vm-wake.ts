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
