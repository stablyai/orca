import type {
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection
} from '../../../src/shared/jira-types'

export type MobileJiraConnection = {
  connected: boolean
  sites: JiraSite[]
  selection: JiraSiteSelection | null
  credentialError: string | null
}

const DISCONNECTED: MobileJiraConnection = {
  connected: false,
  sites: [],
  selection: null,
  credentialError: null
}

// Why: a host that predates the Jira RPCs answers `jira.status` with an error,
// which reaches us as a null result. Treat anything unreadable as disconnected
// so the Tasks surface degrades to the connect prompt instead of throwing.
export function extractJiraConnection(result: unknown): MobileJiraConnection {
  if (!result || typeof result !== 'object') {
    return DISCONNECTED
  }
  const status = result as JiraConnectionStatus
  if (status.connected !== true) {
    return { ...DISCONNECTED, credentialError: status.credentialError?.trim() || null }
  }
  const sites = Array.isArray(status.sites) ? status.sites : []
  return {
    connected: true,
    sites,
    selection: resolveJiraSiteSelection(status, sites),
    credentialError: status.credentialError?.trim() || null
  }
}

function resolveJiraSiteSelection(
  status: JiraConnectionStatus,
  sites: readonly JiraSite[]
): JiraSiteSelection | null {
  const selected = status.selectedSiteId
  if (selected === 'all') {
    return 'all'
  }
  if (typeof selected === 'string' && sites.some((site) => site.id === selected)) {
    return selected
  }
  // A stale selection points at a site that was disconnected since it was saved;
  // fall back to the active site so reads still target something real.
  if (
    typeof status.activeSiteId === 'string' &&
    sites.some((site) => site.id === status.activeSiteId)
  ) {
    return status.activeSiteId
  }
  return sites[0]?.id ?? null
}

export function jiraSiteLabel(site: JiraSite): string {
  const name = site.displayName.trim()
  if (name) {
    return name
  }
  return site.siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
