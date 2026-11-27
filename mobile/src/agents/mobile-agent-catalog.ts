import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_AUTO_PICK_ORDER as MOBILE_TUI_AGENT_AUTO_PICK_ORDER } from '../../../src/shared/agent-launch/catalog/tui-agent-selection'
import { MOBILE_TUI_AGENT_FAVICON_DOMAINS, mobileTuiAgentLabel } from './mobile-tui-agents'

export type MobileAgentCatalogEntry = {
  id: TuiAgent
  label: string
  faviconDomain?: string
}

export const MOBILE_AGENT_CATALOG: MobileAgentCatalogEntry[] = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.map(
  (id) => ({
    id,
    get label() {
      return mobileTuiAgentLabel(id)
    },
    ...(MOBILE_TUI_AGENT_FAVICON_DOMAINS[id]
      ? { faviconDomain: MOBILE_TUI_AGENT_FAVICON_DOMAINS[id] }
      : {})
  })
)
