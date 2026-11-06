import type { AutomationService } from '../automations/service'
import { createRuntimeAutomationService } from '../automations/runtime-automation-service'
import { handOffManagedHostAutomation } from '../automations/managed-host-automation-handoff'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getAppEnvironment } from '../../shared/app-environment'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessAutomations(): AutomationService {
  const store = state.store
  const runtime = state.runtime
  const claudeUsage = state.claudeUsage
  const codexUsage = state.codexUsage
  if (!store || !runtime || !claudeUsage || !codexUsage) {
    throw new Error('Runtime and usage stores must be initialized before automations')
  }
  const service = createRuntimeAutomationService({
    store,
    runtime,
    claudeUsage,
    codexUsage,
    // Remote clients mirror schedules; only server processes execute remote_host_service ownership.
    headless: state.isServeMode
  })
  const userDataPath = (): string => getAppEnvironment().getPath('userData')
  service.handOffManagedHost = async (automation) => {
    const moved = await handOffManagedHostAutomation(
      {
        store,
        environments: () => listEnvironments(userDataPath()),
        callServer: (environmentId, method, params) =>
          callRuntimeEnvironment(userDataPath(), environmentId, method, params)
      },
      automation
    )
    if (moved) {
      service.publishAutomationsChanged()
    }
    return moved
  }
  state.automations = service
  void handOffManagedHostLeftovers()
  return service
}

/** Startup and each managed-server connect: move every desktop row a managed SSH host now owns. */
export async function handOffManagedHostLeftovers(): Promise<void> {
  const service = state.automations
  const store = state.store
  if (!service?.handOffManagedHost || !store) {
    return
  }
  for (const automation of store.listAutomations()) {
    await service.handOffManagedHost(automation)
  }
}
