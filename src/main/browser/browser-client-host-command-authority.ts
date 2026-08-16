import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'

export function assertBrowserClientHostCommandAuthority(
  authority: BrowserClientHostLeaseAuthority,
  command: BrowserClientHostCommandEvent
): void {
  if (
    command.pageCommandProtocolVersion !== authority.pageCommandProtocolVersion ||
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
