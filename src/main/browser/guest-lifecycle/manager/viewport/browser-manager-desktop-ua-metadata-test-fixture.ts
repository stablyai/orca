import type { CdpUserAgentMetadata } from '../../../identity/browser-tab-identity'

// Pinned host client hints so expectations do not depend on the CI platform.
export const pinnedDesktopUserAgentMetadata: CdpUserAgentMetadata = {
  platform: 'macOS',
  platformVersion: '15.4.0',
  architecture: 'arm',
  model: '',
  mobile: false
}

export function withPinnedDesktopUserAgentMetadata<T extends object>(actual: T) {
  return { ...actual, desktopUserAgentMetadata: () => pinnedDesktopUserAgentMetadata }
}
