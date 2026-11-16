import { getOrcadSshDeployment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { OrcaUninstallHostEntry } from '../../shared/uninstall/orca-uninstall-types'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environments/status/runtime-environment-status-probe'
import { ORCA_UNINSTALL_MANUAL_COMMAND } from './orca-uninstall-cleanup'

const STATUS_PROBE_TIMEOUT_MS = 4_000
// The host removes every agent's hooks before it answers.
const REMOVE_TIMEOUT_MS = 60_000

/** SSH hosts running a server Orca deployed; that server installs agent hooks on the host. */
export async function listOrcaUninstallSshHosts(
  userDataPath: string
): Promise<OrcaUninstallHostEntry[]> {
  const environments = (await listEnvironments(userDataPath)).filter((environment) =>
    getOrcadSshDeployment(environment)
  )
  return Promise.all(
    environments.map(async (environment) => {
      const connected = await getRuntimeEnvironmentStatus(
        userDataPath,
        environment.id,
        STATUS_PROBE_TIMEOUT_MS,
        { observeOnly: true }
      )
        .then((response) => response.ok)
        .catch(() => false)
      return {
        hostId: environment.id,
        label: environment.name,
        connected,
        state: connected ? 'present' : 'needs-user',
        detail: connected ? null : 'Not connected.',
        manualCommand: connected ? null : ORCA_UNINSTALL_MANUAL_COMMAND
      } satisfies OrcaUninstallHostEntry
    })
  )
}

/** Turning the host's setting off makes its server remove its managed hooks and stay off. */
export async function removeOrcaUninstallSshHostHooks(
  userDataPath: string,
  hostId: string
): Promise<void> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    hostId,
    'settings.update',
    { agentStatusHooksEnabled: false },
    REMOVE_TIMEOUT_MS
  )
  if (response.ok !== true) {
    throw new Error(response.error.message)
  }
}
