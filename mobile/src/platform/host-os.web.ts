import type { HostOs } from './host-os'

// Platform.OS is web here: read the phone OS for keyboard/inset arithmetic (iPadOS needs the Mac-plus-touch heuristic) and a desktop Mac for Cmd chords.
export function hostOs(): HostOs {
  const agent = globalThis.navigator?.userAgent ?? ''
  if (/iP(ad|hone|od)/.test(agent)) {
    return 'ios'
  }
  if (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator.maxTouchPoints > 1) {
    return 'ios'
  }
  if (agent.includes('Android')) {
    return 'android'
  }
  return agent.includes('Macintosh') ? 'macos' : 'web'
}
