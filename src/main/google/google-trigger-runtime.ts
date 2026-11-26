// Google rules ride the host's automation tick beside Look around, on desktop and `orca serve` alike.
import type { AutomationService } from '../automations/automation-service'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { googleApi } from './google-api-client'
import { listGoogleAccounts, readGoogleDefaultAccount } from './google-credential-store'
import { GoogleTriggerChecker } from './google-trigger-checker'
import { readGoogleTriggerState, writeGoogleTriggerState } from './google-trigger-state'

const TICK_MS = 60_000

export function bindGoogleTriggersToAutomations(
  service: Pick<AutomationService, 'onTick' | 'stop'>,
  store: Pick<Store, 'listAutomations' | 'getBots'>,
  runtime: Pick<OrcaRuntimeService, 'runAutomationForEvent'>
): void {
  const checker = new GoogleTriggerChecker({
    automations: () => store.listAutomations(),
    bots: () => store.getBots(),
    accounts: async () =>
      (await listGoogleAccounts()).flatMap((entry) =>
        'record' in entry && entry.record.status === 'connected' ? [entry.record.email] : []
      ),
    defaultAccount: readGoogleDefaultAccount,
    api: (account) => googleApi(account),
    runForEvent: (automationId, event) => runtime.runAutomationForEvent(automationId, event),
    readState: () => readGoogleTriggerState(),
    writeState: (state) => writeGoogleTriggerState(state),
    now: () => Date.now(),
    tickMs: TICK_MS
  })
  const lookAround = service.onTick
  service.onTick = () => {
    lookAround?.()
    void checker.tick()
  }
  const stop = service.stop.bind(service)
  service.stop = () => {
    checker.stop()
    stop()
  }
}
