/**
 * Haptics inside the shell's page: nothing at all.
 *
 * expo-haptics has a web build, and that is the problem rather than the solution. With no
 * `navigator.vibrate` — iOS Safari, which is the WebView the page runs in — it fakes a haptic by
 * appending a hidden `<label><input type="checkbox" switch>` to `document.head`, clicking it, and
 * removing it again, once per call. C1.9 traced a long press that never fired on the worktree list
 * to exactly that stray click, and the file explorer calls `triggerSelection` on every row tap.
 *
 * So the page has no haptics. A phone holding the page is a phone whose native app is right there
 * with the real ones, and a missing tap feedback is worth less than a tap that does not register.
 *
 * Same five names as the native file, because that is what makes this a substitution: an export
 * added there and missing here is a build error in the bundle, not a silent no-op.
 */
export function triggerMediumImpact(): void {}

export function triggerSelection(): void {}

export function triggerSuccess(): void {}

export function triggerError(): void {}

export function triggerEdgeBump(): void {}
