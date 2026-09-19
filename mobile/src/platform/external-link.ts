import { Linking } from 'react-native'

/**
 * Opening a URL outside the app, which is one call on a phone and a request to the shell on the web.
 *
 * Native: the app's own `Linking`, and nothing between a screen and it. The rejection is swallowed
 * because every caller is a tap handler — `openURL` rejects for a URL no installed app claims, and
 * an unhandled rejection there is a warning nobody reads at best.
 *
 * The web sibling is where this earns its name: inside the shell the page is a document with no
 * `Linking` of its own, so the URL is handed back to the app that has one.
 */
export function openExternalLink(url: string): void {
  void Linking.openURL(url).catch(() => {})
}
