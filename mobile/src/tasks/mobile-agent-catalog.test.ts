import { describe, expect, it } from 'vitest'

import { TUI_AGENT_CONFIG } from '../../../src/shared/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../src/shared/tui-agent-selection'
import { MOBILE_AGENT_CATALOG } from './mobile-agent-catalog'

describe('mobile agent catalog', () => {
  it('follows desktop auto-pick order and covers every configured TUI agent', () => {
    expect(MOBILE_AGENT_CATALOG.map((agent) => agent.id)).toEqual([...TUI_AGENT_AUTO_PICK_ORDER])
    expect(new Set(MOBILE_AGENT_CATALOG.map((agent) => agent.id))).toEqual(
      new Set(Object.keys(TUI_AGENT_CONFIG))
    )
  })

  it('labels every agent with the desktop display name', () => {
    for (const entry of MOBILE_AGENT_CATALOG) {
      expect(entry.label).toBe(TUI_AGENT_DISPLAY_NAMES[entry.id])
    }
  })

  it('uses the bundled Claude icon path for Claude Agent Teams', () => {
    expect(MOBILE_AGENT_CATALOG.find((agent) => agent.id === 'claude-agent-teams')).toEqual(
      expect.not.objectContaining({ faviconDomain: expect.any(String) })
    )
  })
})
