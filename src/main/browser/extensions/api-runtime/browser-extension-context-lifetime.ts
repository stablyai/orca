import type { HostSessionState } from './browser-extension-contexts'

const lifetimesByState = new WeakMap<HostSessionState, Map<string, AbortController>>()

export function getBrowserExtensionContextSignal(
  state: HostSessionState,
  extensionId: string
): AbortSignal {
  let lifetimes = lifetimesByState.get(state)
  if (!lifetimes) {
    lifetimes = new Map()
    lifetimesByState.set(state, lifetimes)
  }
  let lifetime = lifetimes.get(extensionId)
  if (!lifetime) {
    lifetime = new AbortController()
    lifetimes.set(extensionId, lifetime)
  }
  return lifetime.signal
}

export function forgetBrowserExtensionContextLifetime(
  state: HostSessionState | undefined,
  extensionId?: string
): void {
  if (!state) {
    return
  }
  const lifetimes = lifetimesByState.get(state)
  if (extensionId !== undefined) {
    lifetimes?.get(extensionId)?.abort()
    lifetimes?.delete(extensionId)
  } else {
    for (const lifetime of lifetimes?.values() ?? []) {
      lifetime.abort()
    }
    lifetimesByState.delete(state)
  }
}
