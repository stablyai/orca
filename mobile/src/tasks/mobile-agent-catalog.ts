import type { TuiAgent } from '../../../src/shared/types'
import {
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MOBILE_TUI_AGENT_FAVICON_DOMAINS,
  MOBILE_TUI_AGENT_LABELS
} from './mobile-tui-agents'

export type MobileAgentCatalogEntry = {
  id: TuiAgent
  label: string
  faviconDomain?: string
}

export const MOBILE_AGENT_CATALOG: MobileAgentCatalogEntry[] = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.map(
  (id) => ({
    id,
    label: MOBILE_TUI_AGENT_LABELS[id],
    ...(MOBILE_TUI_AGENT_FAVICON_DOMAINS[id]
      ? { faviconDomain: MOBILE_TUI_AGENT_FAVICON_DOMAINS[id] }
      : {})
  })
)
