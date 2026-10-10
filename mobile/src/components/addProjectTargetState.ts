import { REPO_ADD_PROJECT_SSH_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { AddProjectTarget } from './AddProjectTargetSelector'
import type { Dispatch, SetStateAction } from 'react'

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

export function selectAddProjectTarget(
  id: string | null,
  activeId: string | null,
  invalidate: () => void,
  clearDestination: () => void,
  setSelected: Dispatch<SetStateAction<string | null>>
) {
  if (id !== activeId) {
    invalidate()
    clearDestination()
  }
  setSelected(id)
}
