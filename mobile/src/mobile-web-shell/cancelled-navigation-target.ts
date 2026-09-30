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

/**
 * The grant that names this behaviour, declared beside the rule that acts on it.
 *
 * One camelCase token rather than a dotted name, for `screencastBinary`'s reason: the manifest's
 * grant grammar admits a bare name or a `native.<domain>.<action>` verb, and this is not a verb.
 * Nothing is requested and nothing is answered -- the shell cancels a navigation the browser hands
 * it and opens the URL, so there is no reply a page could await. It is not a notify's name either:
 * the page posts nothing to make this happen.
 *
 * It exists as a grant because it is the only thing that can tell a page whether a tap inside the
 * sealed HTML-preview frame escapes at all. A shell built before C7.10 A cancels the navigation and
 * drops it in silence, so a page that rendered the artifact's links as links would be offering a
 * tap that does nothing -- which is what `MobileHtmlPreview.web.tsx` reads this to avoid.
 *
 * A constant and not a platform read: both engines dispatch the event
 * (`ios/MobileWebShellView.swift`, `android/.../MobileWebShellView.kt`), so an app build either
 * carries the behaviour on both or on neither (ruling 37.1).
 */
export const BRIDGE_EXTERNAL_NAVIGATION_GRANT = 'externalNavigation'
