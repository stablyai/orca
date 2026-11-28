/**
 * Builds the move orchestrator once the WSL host service exists. Startup installs the service
 * after the move IPC registers (and a first Add may create it later still), so construction waits
 * for it, and a project-opened that arrives before then is replayed right after construction.
 */
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestrator } from '../../persistence/moving-wsl-projects/wsl-move-orchestrator'
import {
  getWslHostService,
  onWslHostStatusesChanged,
  whenWslHostServiceSet
} from '../../wsl/host-lifecycle/wsl-host-service-instance'

let orchestrator: WslMoveOrchestrator | null = null
let stopWaiting: (() => void) | null = null
const pendingProjectOpened = new Set<string>()

export function currentWslMoveOrchestrator(): WslMoveOrchestrator | null {
  return orchestrator
}

/** T2: the caller has checked the gate, the setting and the sender. */
export function noteWslMoveProjectOpened(distro: string): void {
  if (orchestrator) {
    void orchestrator.trigger(distro, 'project-opened')
  } else {
    pendingProjectOpened.add(distro)
  }
}

/** At most once per run; `wire` attaches the caller's listeners to the new orchestrator. */
export function startWslMoveOrchestratorWithHostService(
  build: () => WslMoveOrchestrator,
  wire: (created: WslMoveOrchestrator) => void
): void {
  stopWaiting?.()
  stopWaiting = null
  if (orchestrator) {
    return
  }
  stopWaiting = whenWslHostServiceSet(() => {
    if (orchestrator) {
      return
    }
    // Runs inside registerCoreHandlers or setWslHostService: a throw would break either caller.
    try {
      const created = build()
      orchestrator = created
      followHostReadiness(created)
      // Before wire: a throw there must not strand the opens that arrived early.
      for (const distro of pendingProjectOpened) {
        void created.trigger(distro, 'project-opened')
      }
      pendingProjectOpened.clear()
      wire(created)
    } catch (error) {
      console.warn('[wsl-move] Move orchestrator did not start:', error)
    }
  })
}

/** T1 and T3: a host reaching ready, or already ready at start, on whichever service is installed. */
function followHostReadiness(created: WslMoveOrchestrator): void {
  const ready = new Set<string>()
  let seen = getWslHostService()
  const observe = (trigger: 'connect' | 'startup'): void => {
    const service = getWslHostService()
    // A new service's hosts reaching ready are new connects, not ones already seen.
    if (service !== seen) {
      seen = service
      ready.clear()
    }
    const now = new Set<string>()
    for (const status of service?.getStatuses() ?? []) {
      if (status.state !== 'ready') {
        continue
      }
      const key = wslMoveJournalKey(status.distro)
      now.add(key)
      if (!ready.has(key)) {
        void created.trigger(status.distro, trigger)
      }
    }
    ready.clear()
    for (const key of now) {
      ready.add(key)
    }
  }
  onWslHostStatusesChanged(() => observe('connect'))
  observe('startup')
}
