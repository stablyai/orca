import type { AgentBrowserTab } from './external-chromium-browser-session'

export type ExternalChromiumPageRecord = {
  agentPageId: string
  publicPageId: string
  worktreeId?: string
}

export function externalChromiumTabInfo(
  page: ExternalChromiumPageRecord,
  tab: AgentBrowserTab,
  index: number
): Record<string, unknown> {
  return {
    browserPageId: page.publicPageId,
    index,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    worktreeId: page.worktreeId ?? null,
    profileId: 'default',
    profileLabel: 'Default'
  }
}

export function externalChromiumSnapshotResult(
  page: ExternalChromiumPageRecord,
  data: {
    refs?: Record<string, { name?: string; role?: string }>
    snapshot?: string
  },
  tab: Record<string, unknown>
): Record<string, unknown> {
  return {
    browserPageId: page.publicPageId,
    snapshot: data.snapshot ?? '',
    refs: Object.entries(data.refs ?? {}).map(([ref, value]) => ({
      ref,
      role: value.role ?? '',
      name: value.name ?? ''
    })),
    url: tab.url,
    title: tab.title
  }
}
