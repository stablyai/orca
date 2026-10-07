import { REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { AddProjectTarget } from './AddProjectTargetSelector'

export function resolveAddProjectTargetState(
  hostCapabilities: readonly string[],
  sshTargets: readonly AddProjectTarget[],
  selectedId: string | null
) {
  const sshSupported = hostCapabilities.includes(REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY)
  const targetOptions: AddProjectTarget[] = sshSupported
    ? [{ id: null, label: 'This host' }, ...sshTargets]
    : []
  const activeSshConnectionId =
    sshSupported && targetOptions.some((target) => target.id === selectedId) ? selectedId : null
  return {
    sshSupported,
    targetOptions,
    activeSshConnectionId,
    selectedTargetAvailable: selectedId === null || activeSshConnectionId !== null
  }
}
