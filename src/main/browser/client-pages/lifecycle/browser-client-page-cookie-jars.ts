import type { BrowserClientPageCookieJar } from './browser-client-page-retained-state'

type PageCookieJarLookup = (browserPageId: string) => BrowserClientPageCookieJar | null

const lookupsByEnvironmentId = new Map<string, PageCookieJarLookup>()

/** Scoped by environment like downloads, so a page's import reaches the composition hosting it. */
export function registerBrowserClientPageCookieJars(
  environmentId: string,
  lookup: PageCookieJarLookup
): () => void {
  lookupsByEnvironmentId.set(environmentId, lookup)
  return () => {
    if (lookupsByEnvironmentId.get(environmentId) === lookup) {
      lookupsByEnvironmentId.delete(environmentId)
    }
  }
}

export function browserClientPageCookieJar(
  environmentId: string,
  browserPageId: string
): BrowserClientPageCookieJar | null {
  return lookupsByEnvironmentId.get(environmentId)?.(browserPageId) ?? null
}
