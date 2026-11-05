import type { HostOs } from './host-os'

export type { HostOs } from './host-os'

// Use the phone OS for keyboard/inset arithmetic: Platform.OS is web here; iPadOS needs the Mac-plus-touch heuristic.
export function hostOs(): HostOs {
  const agent = globalThis.navigator?.userAgent ?? ''
  if (/iP(ad|hone|od)/.test(agent)) {
    return 'ios'
  }
  if (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator.maxTouchPoints > 1) {
    return 'ios'
  }
  return agent.includes('Android') ? 'android' : 'web'
}
