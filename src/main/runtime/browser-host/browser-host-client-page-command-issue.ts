import type { BrowserClientHostCommandEvent } from '../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import { assertBrowserHostPageCommandAdmission } from './browser-host-page-command-admission'
import type { BrowserClientPageAuthority } from './browser-host-page-placement'

/** Issues one page command against the lease generation the caller claims, never a newer one. */
export function issueBrowserHostClientPageCommand(
  authority: BrowserClientPageAuthority,
  command: BrowserClientHostCommandEvent['command'],
  leasesByClientId: ReadonlyMap<string, BrowserHostLeaseState>
): {
  event: BrowserClientHostCommandEvent
  result: Promise<BrowserClientHostCommandResult>
} {
  const state = leasesByClientId.get(authority.browserHostClientId)
  const ledger = state?.commandLedger
  if (!state || state.lease.browserHostGeneration !== authority.browserHostGeneration || !ledger) {
    throw new Error('browser_host_command_protocol_required')
  }
  assertBrowserHostPageCommandAdmission(state.lease, command, (executionHostKey) =>
    state.executionHostGrants.require(executionHostKey)
  )
  return ledger.issue({
    browserPageId: authority.browserPageId,
    pageHostGeneration: authority.pageHostGeneration,
    command
  })
}
