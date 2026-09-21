import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'

type BrowserClientPageAuthority = Pick<
  BrowserClientHostedPageInventory,
  | 'authorityRuntimeId'
  | 'authorityEpoch'
  | 'browserHostClientId'
  | 'browserHostGeneration'
  | 'pageHostGeneration'
>

export function assertBrowserClientHostCommandAuthority(
  authority: BrowserClientHostLeaseAuthority,
  command: BrowserClientHostCommandEvent
): void {
  if (
    command.pageCommandProtocolVersion !== authority.pageCommandProtocolVersion ||
    command.pageReconciliationProtocolVersion !== authority.pageReconciliationProtocolVersion ||
    command.authorityRuntimeId !== authority.authorityRuntimeId ||
    command.authorityEpoch !== authority.authorityEpoch ||
    command.browserHostClientId !== authority.browserHostClientId ||
    command.browserHostGeneration !== authority.browserHostGeneration
  ) {
    throw new Error('browser_host_command_authority_stale')
  }
}

export function snapshotBrowserClientHostLeaseAuthority(
  authority: BrowserClientHostLeaseAuthority
): BrowserClientHostLeaseAuthority {
  return Object.freeze({ ...authority })
}

/**
 * Compares the authority facets a reconnect must preserve to keep the composition alive.
 *
 * Why: `fileChannelProtocolVersion` is deliberately excluded. It gates file transfers only, so a
 * reconnect that renegotiates it degrades `browser.upload`/download per operation instead of
 * fencing every hosted page.
 */
export function sameBrowserClientHostLeaseAuthority(
  left: BrowserClientHostLeaseAuthority,
  right: BrowserClientHostLeaseAuthority
): boolean {
  return (
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageCommandProtocolVersion === right.pageCommandProtocolVersion &&
    left.pageInventoryProtocolVersion === right.pageInventoryProtocolVersion &&
    left.leaseReconnectProtocolVersion === right.leaseReconnectProtocolVersion &&
    left.pageReconciliationProtocolVersion === right.pageReconciliationProtocolVersion
  )
}

export function sameBrowserClientPageAuthority(
  left: BrowserClientPageAuthority,
  right: BrowserClientPageAuthority
): boolean {
  return (
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageHostGeneration === right.pageHostGeneration
  )
}
