type HostSidebarAgentSummaryArgs = {
  embedded: boolean
  hostId?: string
  pathname: string
}

export function shouldShowHostSidebarAgentSummaries({
  embedded,
  hostId,
  pathname
}: HostSidebarAgentSummaryArgs): boolean {
  if (!embedded || !hostId) {
    return true
  }

  return pathname !== `/h/${hostId}/agents`
}
