import { Linking } from 'react-native'

// Catch both synchronous Linking validation and rejected open promises; either can fail a tap, and neither may escape its handler. The page sibling forwards through native.
/** Linking takes any URL here; only the page's shell bridge refuses some. */
export function canOpenExternalLink(_url: string): boolean {
  return true
}

/** Resolves false when no app took the URL, such as a `mailto:` with no mail app installed. */
export async function openExternalLink(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url)
    return true
  } catch (error) {
    // Empty URLs throw before openURL returns a promise; both cases land here.
    console.warn('[platform] could not open a URL', { url }, error)
    return false
  }
}
