import type { BridgeHapticsKind } from '../mobile-web-shell/bridge/bridge-haptics-notify'

/**
 * Haptics inside the shell's page: the device's own, played by the app on the page's behalf.
 *
 * Not `expo-haptics`. It has a web build, and that is the problem rather than the solution: with no
 * `navigator.vibrate` — iOS Safari, which is the WebView the page runs in — it fakes a haptic by
 * appending a hidden `<label><input type="checkbox" switch>` to `document.head`, clicking it, and
 * removing it again, once per call. C1.9 traced a long press that never fired on the worktree list
 * to exactly that stray click, and the file explorer calls `triggerSelection` on every row tap.
 *
 * So the page asks the shell instead, over the `native.haptics.trigger` notify: one frame of 70 to
 * 77 bytes, no reply, and the app's own `Platform.OS` split on the other side. A notify rather than
 * a verb because nothing is owed back — a reply would spend a slot in the same in-flight window a
 * forwarded request does, and there are 90 call sites in this app (rulings-ota-c7.md ruling 30).
 *
 * Published by the entry rather than read from context, because the callers are plain functions in
 * render trees the provider does not wrap — the same reason `publishExternalLinkOpener` exists. A
 * document that published none, or a shell that granted no `haptics`, plays nothing and says
 * nothing: a warning here would be one per row of a scrolling list, and nobody reads the answer.
 *
 * Same five names as the native file, because that is what makes this a substitution: an export
 * added there and missing here is a build error in the bundle, not a silent no-op.
 */
type HapticsNotifier = (kind: BridgeHapticsKind) => boolean

let post: HapticsNotifier = () => false

/** Called once by the entry, with the page client's own notify. */
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
