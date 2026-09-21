/**
 * The Azure DevOps base URLs the execution host is configured with, and the
 * rule that maps a requested organization name onto one of them.
 *
 * `ORCA_AZURE_DEVOPS_API_BASE_URL` holds a comma-separated list because one PAT
 * commonly spans several organizations. The host owns this set: a caller may
 * select an entry by organization name and can never name an origin outside it.
 */

export type AzureDevOpsBaseUrlResolution =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: 'not-configured' | 'unknown-organization' }

export function normalizeAzureDevOpsApiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/_apis$/i, '')
}

/**
 * Splits, normalizes and deduplicates a configured list. Order is preserved:
 * the first entry serves every request that names no organization. Entries that
 * differ only in case are one organization, so the later spelling is dropped
 * rather than kept as a name that could never resolve.
 */
export function parseAzureDevOpsApiBaseUrls(value: string | null | undefined): string[] {
  const seen = new Set<string>()
  const baseUrls: string[] = []
  for (const entry of (value ?? '').split(',')) {
    const normalized = normalizeAzureDevOpsApiBaseUrl(entry)
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue
    }
    seen.add(normalized.toLowerCase())
    baseUrls.push(normalized)
  }
  return baseUrls
}

export function getConfiguredAzureDevOpsApiBaseUrls(): string[] {
  return parseAzureDevOpsApiBaseUrls(process.env.ORCA_AZURE_DEVOPS_API_BASE_URL)
}

/** The final path segment of a base URL: `https://dev.azure.com/{org}`. */
export function azureDevOpsOrganizationName(baseUrl: string): string | null {
  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, '')
    const segment = path.slice(path.lastIndexOf('/') + 1)
    return segment ? decodeURIComponent(segment) : null
  } catch {
    return null
  }
}

/** Configured organization names only. Never a URL, never credential material. */
export function listConfiguredAzureDevOpsOrganizations(): string[] {
  const names: string[] = []
  for (const baseUrl of getConfiguredAzureDevOpsApiBaseUrls()) {
    const name = azureDevOpsOrganizationName(baseUrl)
    if (name) {
      names.push(name)
    }
  }
  return names
}

export function resolveAzureDevOpsApiBaseUrl(
  organization?: string | null
): AzureDevOpsBaseUrlResolution {
  const baseUrls = getConfiguredAzureDevOpsApiBaseUrls()
  const first = baseUrls[0]
  if (!first) {
    return { ok: false, reason: 'not-configured' }
  }
  const requested = organization?.trim() ?? ''
  if (!requested) {
    return { ok: true, baseUrl: first }
  }
  // Azure DevOps organization names are case-insensitive in URLs.
  const match = baseUrls.find(
    (baseUrl) => azureDevOpsOrganizationName(baseUrl)?.toLowerCase() === requested.toLowerCase()
  )
  // An organization outside the configured set is refused, never served by
  // another entry: falling back would send the credential to an origin the
  // caller chose instead of one the user approved.
  return match ? { ok: true, baseUrl: match } : { ok: false, reason: 'unknown-organization' }
}
