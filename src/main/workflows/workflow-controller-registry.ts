import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { WorkflowController } from './workflow-controller'
import { createWorkflowOrcaAdapter } from './workflow-orca-adapter'
import { WorkflowStore } from './workflow-store'

const controllers = new WeakMap<OrcaRuntimeService, WorkflowController>()
const RECOVERY_DELAY_MS = 5_000

/** One controller per runtime; its store lives beside the orchestration database it drives. */
export function getWorkflowController(runtime: OrcaRuntimeService): WorkflowController {
  let controller = controllers.get(runtime)
  if (!controller) {
    const adapter = createWorkflowOrcaAdapter(runtime)
    controller = new WorkflowController(
      new WorkflowStore(join(getAppEnvironment().getPath('userData'), 'workflows')),
      adapter,
      {
        capabilities: async () => ({
          detectedAgents: await adapter.detectAgents(),
          installedSkills: await adapter.installedSkills(),
          openCodeModelLaunchSupported: true
        })
      }
    )
    controllers.set(runtime, controller)
  }
  return controller
}

/** Resume live workflow runs once startup has restored orchestration authority. */
export function startWorkflowControllerRecovery(
  runtime: OrcaRuntimeService,
  onQuit: (dispose: () => void) => void
): void {
  const timer = setTimeout(() => {
    getWorkflowController(runtime)
      .recoverAll()
      .catch((error: unknown) => console.error('[workflows] recovery failed', error))
  }, RECOVERY_DELAY_MS)
  timer.unref?.()
  onQuit(() => {
    clearTimeout(timer)
    controllers.get(runtime)?.dispose()
  })
}
