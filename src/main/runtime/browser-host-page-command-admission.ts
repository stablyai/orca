import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY } from '../../shared/browser-client-file-channel-protocol'
import {
  BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR,
  requiresBrowserClientFileChannel
} from '../../shared/browser-client-file-channel-methods'
import type { BrowserHostLease } from './browser-host-lease-records'

export function assertBrowserHostPageCommandAdmission(
  lease: BrowserHostLease,
  command: BrowserClientHostCommandEvent['command'],
  requireExecutionHost: (executionHostKey: string) => void
): void {
  if (
    command.type !== 'createPage' &&
    command.type !== 'navigate' &&
    command.type !== 'automation' &&
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
  if (
    command.type === 'automation' &&
    !lease.hostCapabilities.includes(BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY)
  ) {
    throw new Error('browser_host_capability_unavailable')
  }
  if (
    command.type === 'automation' &&
    requiresBrowserClientFileChannel(command.method) &&
    (lease.fileChannelProtocolVersion !== 1 ||
      !lease.hostCapabilities.includes(BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY))
  ) {
    throw new Error(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
  }
}
