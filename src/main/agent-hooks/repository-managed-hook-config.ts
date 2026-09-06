import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isRepositoryManagedHookConfigSymlink } from './hook-config-write-path'

type HookConfigIdentity = Pick<AgentHookInstallStatus, 'agent'> & { displayName: string }

export function getRepositoryManagedHookConfigStatus(
  configPath: string,
  identity: HookConfigIdentity
): AgentHookInstallStatus | null {
  if (!isRepositoryManagedHookConfigSymlink(configPath)) {
    return null
  }
  return {
    agent: identity.agent,
    state: 'not_installed',
    configPath,
    managedHooksPresent: false,
    detail: `Refusing to modify repository-managed ${identity.displayName} settings symlink`
  }
}
