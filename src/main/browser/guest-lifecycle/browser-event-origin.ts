import { normalizeExternalBrowserUrl } from '../../../shared/browser-url'

export function safeOrigin(rawUrl: string): string {
  const external = normalizeExternalBrowserUrl(rawUrl)
  const urlToParse = external ?? rawUrl
  try {
    return new URL(urlToParse).origin
  } catch {
    return external ?? 'unknown'
  }
}
