import type { JiraSite, JiraSiteSelection } from '../../../src/shared/jira-types'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { RpcResponse } from '../transport/types'
import { jiraConnectionStatusSchema } from './jira-reply-schema'
import { jiraConnectionStatusProbe, jiraConnectionStatusRead } from './mobile-jira-operations'

export type MobileJiraConnection = {
  connected: boolean
  sites: JiraSite[]
  selection: JiraSiteSelection | null
  credentialError: string | null
  unavailableReason: string | null
}

const DISCONNECTED: MobileJiraConnection = {
  connected: false,
  sites: [],
  selection: null,
  credentialError: null,
  unavailableReason: null
}

export function extractJiraConnection(result: unknown): MobileJiraConnection {
  const decoded = jiraConnectionStatusSchema.safeParse(result)
  if (!decoded.success) {
    return { ...DISCONNECTED, unavailableReason: 'Update Orca desktop to browse Jira on mobile.' }
  }
  const status = decoded.data
  const credentialError = status.credentialError?.trim() || null
  if (!status.connected) {
    return { ...DISCONNECTED, credentialError }
  }
  const sites = status.sites ?? []
  return {
    connected: true,
    sites,
    selection: resolveJiraSiteSelection(status, sites),
    credentialError,
    unavailableReason: null
  }
}

// Older hosts can refuse Jira without taking the other task providers down.
export function readJiraConnectionProbeReply(reply: RpcResponse | null): MobileJiraConnection {
  try {
    if (reply) {
      const result = jiraConnectionStatusProbe.interpret(reply)
      if (result.accepted) {
        return extractJiraConnection(result.value)
      }
    }
  } catch {
    // An incompatible advisory reply leaves the remaining providers usable.
  }
  return extractJiraConnection(null)
}

export function reconcileJiraConnection(
  current: MobileJiraConnection,
  next: MobileJiraConnection
): MobileJiraConnection {
  const selected = current.selection
  return selected === 'all' || next.sites.some((site) => site.id === selected)
    ? { ...next, selection: selected }
    : next
}

function resolveJiraSiteSelection(
  status: { selectedSiteId?: string | null; activeSiteId?: string | null },
  sites: readonly JiraSite[]
): JiraSiteSelection | null {
  const selected = status.selectedSiteId
  if (selected === 'all') {
    return 'all'
  }
  if (typeof selected === 'string' && sites.some((site) => site.id === selected)) {
    return selected
  }
  // A disconnected selection falls back to an available site.
  if (
    typeof status.activeSiteId === 'string' &&
    sites.some((site) => site.id === status.activeSiteId)
  ) {
    return status.activeSiteId
  }
  return sites[0]?.id ?? null
}

// Explicit refreshes surface failures instead of presenting a setup prompt.
export async function readJiraConnection(
  client: RpcOperationSender
): Promise<MobileJiraConnection> {
  return extractJiraConnection(
    jiraConnectionStatusRead.interpret(await jiraConnectionStatusRead.request(client))
  )
}

export function jiraSiteLabel(site: JiraSite): string {
  const name = site.displayName.trim()
  if (name) {
    return name
  }
  return site.siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
