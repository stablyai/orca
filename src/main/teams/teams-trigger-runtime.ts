// Teams rules on the host's automation tick.
import type { AutomationService } from '../automations/automation-service'
import { rideAutomationTick } from '../automations/automation-tick-rider'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getTeamsConnect } from './teams-connect'
import { TeamsTriggerChecker } from './teams-trigger-checker'
import { readTeamsTriggerState, writeTeamsTriggerState } from './teams-trigger-state'

export function bindTeamsTriggersToAutomations(
  service: Pick<AutomationService, 'onTick' | 'stop'>,
  store: Pick<Store, 'listAutomations' | 'getBots'>,
  runtime: Pick<OrcaRuntimeService, 'runAutomationForEvent'>
): void {
  const checker = new TeamsTriggerChecker({
    automations: () => store.listAutomations(),
    bots: () => store.getBots(),
    graph: () => getTeamsConnect().graph,
    runForEvent: (automationId, event) => runtime.runAutomationForEvent(automationId, event),
    readState: () => readTeamsTriggerState(),
    writeState: (state) => writeTeamsTriggerState(state),
    now: () => Date.now()
  })
  rideAutomationTick(service, checker)
}
