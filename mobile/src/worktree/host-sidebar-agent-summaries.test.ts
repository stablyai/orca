import { describe, expect, it } from 'vitest'
import { shouldShowHostSidebarAgentSummaries } from './host-sidebar-agent-summaries'

describe('shouldShowHostSidebarAgentSummaries', () => {
  it('hides duplicated agent summaries when the tablet detail pane shows Agents', () => {
    expect(
      shouldShowHostSidebarAgentSummaries({
        embedded: true,
        hostId: 'mock-host',
        pathname: '/h/mock-host/agents'
      })
    ).toBe(false)
  })

  it('keeps agent summaries on the host route and phone layout', () => {
    expect(
      shouldShowHostSidebarAgentSummaries({
        embedded: true,
        hostId: 'mock-host',
        pathname: '/h/mock-host'
      })
    ).toBe(true)
    expect(
      shouldShowHostSidebarAgentSummaries({
        embedded: false,
        hostId: 'mock-host',
        pathname: '/h/mock-host/agents'
      })
    ).toBe(true)
  })
})
