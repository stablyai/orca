export const INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES = 250_000
export const INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES = 64 * 1024 * 1024

export type InstalledBrowserCookieStoreLimitKind = 'cookies' | 'bytes'

export class InstalledBrowserCookieStoreLimitError extends Error {
  constructor(
    readonly kind: InstalledBrowserCookieStoreLimitKind,
    readonly observed: number | bigint,
    readonly limit: number
  ) {
    super(`Installed browser cookie store exceeds the ${kind} limit`)
    this.name = 'InstalledBrowserCookieStoreLimitError'
  }
}

export function assertInstalledBrowserCookieStoreWithinLimits(
  cookieCount: number | bigint,
  cookieBytes: number | bigint
): number {
  enforceLimit('cookies', cookieCount, INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES)
  enforceLimit('bytes', cookieBytes, INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES)
  return Number(cookieCount)
}

export function installedBrowserCookieStoreLimitReason(browserLabel: string): string {
  return `${browserLabel} cookie store is too large to import safely (${INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES.toLocaleString('en-US')}-cookie and ${INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES / 1024 / 1024} MiB cookie-data limits).`
}

function enforceLimit(
  kind: InstalledBrowserCookieStoreLimitKind,
  observed: number | bigint,
  limit: number
): void {
  if (
    (typeof observed === 'bigint' && observed > BigInt(limit)) ||
    (typeof observed === 'number' && (!Number.isSafeInteger(observed) || observed > limit))
  ) {
    throw new InstalledBrowserCookieStoreLimitError(kind, observed, limit)
  }
}
