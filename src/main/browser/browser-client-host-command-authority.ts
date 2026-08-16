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

export function sameBrowserClientHostLeaseAuthority(
  left: BrowserClientHostLeaseAuthority,
  right: BrowserClientHostLeaseAuthority
): boolean {
  return (
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration &&
    left.pageCommandProtocolVersion === right.pageCommandProtocolVersion
  )
}
