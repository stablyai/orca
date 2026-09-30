import { Linking } from 'react-native'

/**
 * Opening a URL outside the app, which is one call on a phone and a request to the shell on the web.
 *
 * Native: the app's own `Linking`, and nothing between a screen and it but the two ways it fails.
 * It rejects for a URL no installed app claims, and it *throws* before returning a promise for one
 * its own validation refuses, so a `.catch` alone leaves that second one escaping a tap handler.
 * Both are reported and neither is rethrown.
 *
 * The web sibling is where this earns its name: inside the shell the page is a document with no
 * `Linking` of its own, so the URL is handed back to the app that has one.
 */
export function openExternalLink(url: string): void {
  try {
    void Linking.openURL(url).catch((error: unknown) => {
      report(url, error)
    })
  } catch (error) {
    // `openURL` validates before it returns anything — `_validateURL` is an `invariant` that throws
    // for an empty string — so this arm is the only one that sees that failure. The `catch` above
    // is attached to a promise which, in that case, never exists.
    report(url, error)
  }
}

/** Named rather than swallowed: nothing else records a tap that opened nothing. */
function report(url: string, error: unknown): void {
  console.warn('[platform] could not open a URL', { url }, error)
}
