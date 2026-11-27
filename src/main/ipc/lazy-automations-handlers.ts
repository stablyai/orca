import type { Store } from '../persistence/loading-store/store'
import type { AutomationService } from '../automations/automation-service'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const AUTOMATION_IPC_CHANNELS = [
  'automations:listExternalManagerForOwner',
  'automations:runExternalActionForOwner',
  'automations:retainExternalScopes',
  'automations:snapshotWorkspaceName'
] as const

export function registerLazyAutomationHandlers(store: Store, service: AutomationService): void {
  registerLazyIpcHandleGroup(AUTOMATION_IPC_CHANNELS, async (ipc) => {
    const { registerAutomationHandlers } = await import('./automations')
    registerAutomationHandlers(store, service, ipc)
  })
}
