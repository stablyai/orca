import { readBridgeExternalLinkUrl } from './bridge/bridge-caps'

/**
 * The URL to open for a main-frame navigation the shell cancelled, or null to open nothing.
 *
 * The shell cancels every navigation off its own document and now offers the URL back rather than
 * dropping it in silence, because one of those is a user tapping a link inside the sealed
 * HTML-preview frame: the browser hands a user-activated `target="_top"` navigation up to the top
 * frame, and the shell's policy is the only thing that can act on it.
 *
 * The scheme list is `readBridgeExternalLinkUrl`'s and is not restated natively — the native side
 * caps the string and says which frame it came from, nothing more, so the rule that decides what
 * opens lives in the half that ships over the air. The normalized href is what opens, never the
 * string the document spelled: the WHATWG parser strips tab, LF and CR from anywhere, so
 * `ht\ntps://x` reaches this as something a device handler should not be given.
 *
 * A non-string reaches this only from a native payload that changed shape, which is a reason to
 * open nothing rather than to throw on the native frame handler.
 */
export function cancelledShellNavigationTarget(url: unknown): string | null {
  return typeof url === 'string' ? readBridgeExternalLinkUrl(url) : null
}
