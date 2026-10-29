import type { BridgeInitHost } from './bridge-envelope'

// Publish the init host before render for plain host-store.web.ts functions outside React context; this document’s host never changes.
let profile: BridgeInitHost | null = null

export function publishPageHostProfile(next: BridgeInitHost | null): void {
  profile = next
}

export function readPageHostProfile(): BridgeInitHost | null {
  return profile
}
