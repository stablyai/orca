import type { BridgeHapticsKind } from '../mobile-web-shell/bridge/bridge-haptics-notify'

// Ask native through a notify: Expo’s web fallback clicks a hidden checkbox on iOS, disrupting long presses. No reply slot is needed.
// Publish outside React for plain-function callers; ungranted haptics stay quiet to avoid logging every list tap.
type HapticsNotifier = (kind: BridgeHapticsKind) => boolean

let post: HapticsNotifier = () => false

export function publishHapticsNotifier(notify: HapticsNotifier): void {
  post = notify
}

export function triggerMediumImpact(): void {
  post('mediumImpact')
}

export function triggerSelection(): void {
  post('selection')
}

export function triggerSuccess(): void {
  post('success')
}

export function triggerError(): void {
  post('error')
}

export function triggerEdgeBump(): void {
  post('edgeBump')
}
