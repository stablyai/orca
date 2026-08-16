import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { BrowserHostLease } from './browser-host-lease-records'

export function assertBrowserHostPageCommandAdmission(
  lease: BrowserHostLease,
  command: BrowserClientHostCommandEvent['command'],
  requireExecutionHost: (executionHostKey: string) => void
): void {
  if (
    command.type !== 'createPage' &&
    command.type !== 'navigate' &&
    lease.pageReconciliationProtocolVersion !== 1
  ) {
    throw new Error('browser_host_reconciliation_protocol_required')
  }
  if (
    command.type === 'createPage' ||
    command.type === 'reclaimPage' ||
    command.type === 'restorePage'
  ) {
    requireExecutionHost(command.executionHostKey)
  }
}
