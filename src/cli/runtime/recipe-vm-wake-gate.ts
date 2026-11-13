import {
  findEnvironmentEphemeralVmRuntime,
  isEphemeralVmSuspended
} from '../../shared/ephemeral-vm-environment-sleep'
import {
  HOST_RECIPE_VM_WAKE_CAPABILITY,
  RECIPE_VM_WAKE_METHOD,
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
  recipeVmWakeIntentFor
} from '../../shared/remote-runtime/recipe-vm-wake'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { resolveEnvironment } from './environments'
import { readMetadata } from './metadata'
import { sendRequest } from './transport'
import { RuntimeClientError } from './types'

// A recipe's resume boots a VM; the CLI waits this long before telling the user to retry.
const RECIPE_VM_WAKE_TIMEOUT_MS = 5 * 60_000
const DESKTOP_STATUS_TIMEOUT_MS = 10_000

/** How the desktop answered a request to open a VM's workspace: the VM is up, the desktop
 *  cannot wake it, or it was still waking when the CLI stopped waiting. */
export type DesktopRecipeVmWake = 'up' | 'unsupported' | 'still-waking'

/**
 * A recipe VM's server is unreachable while the VM is suspended, and only the desktop that owns
 * the VM can run the recipe's resume. A command that opens the workspace asks it to wake the VM
 * first; any other command says the VM is asleep instead of timing out against nothing.
 * 'reload' means the desktop answered for a VM it may have just resumed (by this request or a
 * concurrent one), which re-pairs the server, so its connection must be read again.
 */
export async function prepareRecipeVmEnvironmentCall(
  userDataPath: string,
  environmentSelector: string,
  method: string,
  askDesktopToWake: (environmentId: string) => Promise<DesktopRecipeVmWake> = (environmentId) =>
    askDesktopToWakeRecipeVm(userDataPath, environmentId)
): Promise<'unchanged' | 'reload'> {
  const environment = await resolveEnvironment(userDataPath, environmentSelector)
  const vm = findEnvironmentEphemeralVmRuntime(userDataPath, environment)
  if (!vm) {
    return 'unchanged'
  }
  // Why the desktop decides for an open: only it knows a suspend still running under a VM
  // whose record says running.
  if (recipeVmWakeIntentFor(method) === 'none') {
    if (!isEphemeralVmSuspended(vm)) {
      return 'unchanged'
    }
    throw new RuntimeClientError(
      RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
      `The VM behind environment "${environment.name}" is asleep. Run \`orca worktree activate --worktree <selector>\` for its workspace, or open it in Orca, to wake it.`
    )
  }
  const answer = await askDesktopToWake(environment.id)
  if (answer === 'unsupported' && !isEphemeralVmSuspended(vm)) {
    // An older or absent desktop: the VM's record says it runs, so try its server.
    return 'unchanged'
  }
  if (answer === 'unsupported') {
    throw new RuntimeClientError(
      RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
      `The VM behind environment "${environment.name}" is asleep, and no running Orca here can wake it. Open Orca and open the workspace to wake it.`
    )
  }
  if (answer === 'still-waking') {
    throw new RuntimeClientError(
      RUNTIME_ENVIRONMENT_WAKING_ERROR_CODE,
      `The VM behind environment "${environment.name}" is still waking up. Try again in a moment.`
    )
  }
  // Up now, perhaps woken since this command read the server's pairing.
  return 'reload'
}

/** The desktop owns recipe VMs; the CLI only asks it to run the wake and waits for it. */
async function askDesktopToWakeRecipeVm(
  userDataPath: string,
  environmentId: string
): Promise<DesktopRecipeVmWake> {
  let metadata: ReturnType<typeof readMetadata>
  let status: Awaited<ReturnType<typeof sendRequest<RuntimeStatus>>>
  try {
    metadata = readMetadata(userDataPath)
    status = await sendRequest<RuntimeStatus>(
      metadata,
      'status.get',
      undefined,
      DESKTOP_STATUS_TIMEOUT_MS
    )
  } catch {
    // No desktop is running here, so nothing can run the recipe's resume.
    return 'unsupported'
  }
  if (!status.ok || !status.result.capabilities?.includes(HOST_RECIPE_VM_WAKE_CAPABILITY)) {
    return 'unsupported'
  }
  try {
    const opened = await sendRequest(
      metadata,
      RECIPE_VM_WAKE_METHOD,
      { environment: environmentId },
      RECIPE_VM_WAKE_TIMEOUT_MS
    )
    if (!opened.ok) {
      throw new RuntimeClientError(opened.error.code, opened.error.message)
    }
    return 'up'
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'runtime_timeout') {
      return 'still-waking'
    }
    throw error
  }
}
