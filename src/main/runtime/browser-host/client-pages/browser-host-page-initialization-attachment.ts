import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientHostedPageInventory } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type {
  Initialization,
  InitializationRecord
} from './browser-host-page-initialization-records'
import {
  sameInitializationTarget,
  currentInitializationRequest
} from './browser-host-page-initialization-records'
import { forgetAbsentInitializationTarget } from './browser-host-page-initialization-commands'

export function observeInitializationAttach(
  records: Map<string, InitializationRecord>,
  state: BrowserHostLeaseState,
  inventory: readonly BrowserClientHostedPageInventory[] | undefined,
  cancel: (operation: Initialization) => void,
  removeRecord: (record: InitializationRecord) => void
): void {
  const byPage = inventory && new Map(inventory.map((page) => [page.browserPageId, page]))
  for (const record of records.values()) {
    if (
      record.browserHostClientId !== state.lease.browserHostClientId ||
      record.pairedDeviceId !== state.lease.pairedDeviceId
    ) {
      continue
    }
    const operation = record.operation
    if (
      operation &&
      operation.admission.connectionToken !== state.connectionToken &&
      !(
        state.lease.hostCapabilities.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY) &&
        currentInitializationRequest(record, state)
      )
    ) {
      cancel(operation)
    }
    const target = record.target
    if (!target || !byPage || sameInitializationTarget(target, byPage.get(record.browserPageId))) {
      continue
    }
    // A dispatcher-queued create is absent from inventory but can still allocate on replay.
    if (
      operation &&
      state.commandLedger?.hasOutstandingPageCreation(
        record.browserPageId,
        target.pageHostGeneration
      )
    ) {
      continue
    }
    if (operation) {
      forgetAbsentInitializationTarget(operation, target)
      if (operation.admission.state === state) {
        state.commandLedger?.retirePage(record.browserPageId, target.pageHostGeneration)
      }
    } else {
      record.target = undefined
      record.releaseCleanup?.()
      record.releaseCleanup = undefined
      removeRecord(record)
    }
  }
}
