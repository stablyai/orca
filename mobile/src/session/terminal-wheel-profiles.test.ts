import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { MobileSessionTab } from './mobile-session-route-types'
import { terminalWheelProfiles } from './terminal-wheel-profiles'

function terminalTab(
  terminal: string | null,
  identity: { launchAgent?: TuiAgent; title?: string } = {}
): MobileSessionTab {
  return {
    type: 'terminal',
    id: `tab-${terminal}`,
    title: identity.title ?? 'zsh',
    terminal,
    isActive: false,
    ...(identity.launchAgent ? { launchAgent: identity.launchAgent } : {})
  }
}

describe('terminalWheelProfiles', () => {
  it('paces Claude Code and reports Codex over its history; every other pane moves a row a report', () => {
    const profiles = terminalWheelProfiles([
      terminalTab('pty-claude', { launchAgent: 'claude' }),
      terminalTab('pty-codex', { launchAgent: 'codex' }),
      terminalTab('pty-gemini', { launchAgent: 'gemini' }),
      terminalTab('pty-shell'),
      terminalTab(null, { launchAgent: 'claude' })
    ])

    expect([...profiles]).toEqual([
      ['pty-claude', 'claude-code'],
      ['pty-codex', 'codex']
    ])
  })
})
