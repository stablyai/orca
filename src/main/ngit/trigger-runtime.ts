// ngit rules ride the host's automation tick beside Google's, on desktop and `orca serve` alike.
import type { AutomationService } from '../automations/automation-service'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getNgitViewer } from './ngit-viewer'
import { getNostrRepositorySnapshot } from './repository-snapshot'
import { NgitTriggerChecker } from './trigger-checker'
import { readNgitTriggerState, writeNgitTriggerState } from './trigger-state'

export function bindNgitTriggersToAutomations(
  service: Pick<AutomationService, 'onTick'>,
  store: Pick<Store, 'listAutomations'>,
  runtime: Pick<OrcaRuntimeService, 'runAutomationForEvent'>
): void {
  const checker = new NgitTriggerChecker({
    automations: () => store.listAutomations(),
    read: (address) => getNostrRepositorySnapshot(address, { force: true }),
    ownNpub: async () => (await getNgitViewer()).account?.npub ?? null,
    runForEvent: (automationId, event) => runtime.runAutomationForEvent(automationId, event),
    readState: () => readNgitTriggerState(),
    writeState: (state) => writeNgitTriggerState(state),
    now: () => Date.now()
  })
  const previousTick = service.onTick
  service.onTick = () => {
    previousTick?.()
    void checker.tick()
  }
}
