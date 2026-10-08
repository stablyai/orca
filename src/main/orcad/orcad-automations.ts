/**
 * orcad executes the profile's schedules, as `orca serve` on Electron does. Without this a
 * persisted or migrated automation lists fine but never runs, and "Run now" has no service.
 */
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createRuntimeAutomationService } from '../automations/runtime-automation-service'
import { isFinalAutomationRunStatus } from '../../shared/automations-types'

type AutomationStore = Pick<Store, 'listAutomations' | 'listAutomationRuns'>

let stopScheduler: (() => void) | null = null

export function startOrcadAutomations(
  runtime: OrcaRuntimeService,
  store: Store,
  registerCleanup: (cleanup: () => void) => void
): void {
  const service = createRuntimeAutomationService({ store, runtime, headless: true })
  stopScheduler = () => service.stop()
  // Stops before the store flushes, so no run is written after the final profile save.
  registerCleanup(() => service.stop())
  service.start()
}

/** Halts scheduling and in-flight dispatch; a no-op before the service starts. */
export function stopOrcadAutomationScheduler(): void {
  stopScheduler?.()
}

/** Busy while a schedule may fire or a run has not settled; idling out would skip both. */
export function orcadAutomationsKeepHostBusy(store: AutomationStore): boolean {
  return (
    store.listAutomations().some((automation) => automation.enabled) ||
    store.listAutomationRuns().some((run) => !isFinalAutomationRunStatus(run.status))
  )
}
