import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  getMobileTerminalTabHostAgentIdentity,
  resolveMobileTerminalTabAgentId,
  resolveMobileTerminalTabOwnedAgentId
} from './mobile-terminal-tab-agent'

function agentStatus(agentType: string | undefined): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'tab-1:leaf-1',
    ...(agentType ? { agentType } : {}),
    stateHistory: []
  }
}

function terminalTab(
  title: string,
  options: { agentType?: string; id?: string; launchAgent?: TuiAgent } = {}
): Extract<MobileSessionTab, { type: 'terminal' }> {
  return {
    type: 'terminal',
    id: options.id ?? 'tab-1',
    title,
    terminal: 'pty-1',
    isActive: true,
    ...(options.launchAgent ? { launchAgent: options.launchAgent } : {}),
    ...(options.agentType === undefined ? {} : { agentStatus: agentStatus(options.agentType) })
  }
}

describe('resolveMobileTerminalTabAgentId', () => {
  it('uses hook-reported agent identity before title fallback', () => {
    expect(resolveMobileTerminalTabAgentId(terminalTab('Terminal', { agentType: 'codex' }))).toBe(
      'codex'
    )
  })

  it('uses host launch identity before title fallback', () => {
    expect(
      resolveMobileTerminalTabAgentId(terminalTab('Terminal', { launchAgent: 'claude' }))
    ).toBe('claude')
  })

  it('keeps hook identity authoritative over launch identity', () => {
    expect(
      resolveMobileTerminalTabAgentId(
        terminalTab('Terminal', { agentType: 'codex', launchAgent: 'claude' })
      )
    ).toBe('codex')
  })

  it('falls back to explicit terminal titles when hook identity is unavailable', () => {
    expect(resolveMobileTerminalTabAgentId(terminalTab('✦ Gemini CLI'))).toBe('gemini')
  })

  it('does not let title fallback override launch identity', () => {
    expect(
      resolveMobileTerminalTabAgentId(terminalTab('Codex ready', { launchAgent: 'claude' }))
    ).toBe('claude')
  })

  it('treats unknown hook identity as unavailable', () => {
    expect(
      resolveMobileTerminalTabAgentId(terminalTab('✳ investigating', { agentType: 'unknown' }))
    ).toBeNull()
    expect(
      resolveMobileTerminalTabAgentId(terminalTab('Codex ready', { agentType: 'unknown' }))
    ).toBe('codex')
  })
})

describe('host pane identity', () => {
  it('prefers the host cursor identity over a claude report from a Claude hook Cursor imported', () => {
    const tab = terminalTab('Fix the build - ⏳ Working ···', { agentType: 'claude' })
    expect(resolveMobileTerminalTabAgentId(tab)).toBe('claude')
    expect(resolveMobileTerminalTabAgentId(tab, 'cursor')).toBe('cursor')
    expect(resolveMobileTerminalTabOwnedAgentId(tab, 'cursor')).toBe('cursor')
  })

  it('does not replace a launch identity Orca chose', () => {
    expect(
      resolveMobileTerminalTabAgentId(terminalTab('Terminal', { launchAgent: 'claude' }), 'cursor')
    ).toBe('claude')
  })

  it('keeps launch identity when the hook report is unknown', () => {
    const tab = terminalTab('Terminal', { agentType: 'unknown', launchAgent: 'claude' })
    expect(resolveMobileTerminalTabOwnedAgentId(tab, 'cursor')).toBe('claude')
    expect(resolveMobileTerminalTabAgentId(tab, 'cursor')).toBe('claude')
  })

  it("does not replace another agent's hook report", () => {
    for (const agentType of ['codex', 'grok', 'gemini']) {
      expect(
        resolveMobileTerminalTabAgentId(terminalTab('Terminal', { agentType }), 'cursor')
      ).toBe(agentType)
    }
  })

  it('keeps a real Claude tab as Claude when the host says claude or has no identity', () => {
    const tab = terminalTab('✳ working', { agentType: 'claude' })
    expect(resolveMobileTerminalTabAgentId(tab, 'claude')).toBe('claude')
    expect(resolveMobileTerminalTabAgentId(tab, undefined)).toBe('claude')
    expect(resolveMobileTerminalTabAgentId(tab, null)).toBe('claude')
  })

  it('shows Cursor for a saved task name with no hook or launch identity', () => {
    expect(resolveMobileTerminalTabAgentId(terminalTab('Saved task name'), 'cursor')).toBe('cursor')
    expect(
      resolveMobileTerminalTabOwnedAgentId(terminalTab('Saved task name'), 'cursor')
    ).toBeNull()
  })

  it('cleans the title with the same host identity the icon uses', () => {
    expect(getMobileSessionTabTitle(terminalTab('✳ investigating'))).toBe('✳ investigating')
    expect(getMobileSessionTabTitle(terminalTab('✳ investigating'), 'cursor')).toBe('investigating')
  })

  it("reads the host identity from the terminal.list record of the tab's handle", () => {
    const terminals = [
      { handle: 'pty-0', agentIdentity: 'codex' },
      { handle: 'pty-1', agentIdentity: 'cursor' }
    ]
    expect(getMobileTerminalTabHostAgentIdentity(terminalTab('Terminal'), terminals)).toBe('cursor')
    expect(
      getMobileTerminalTabHostAgentIdentity(
        { ...terminalTab('Terminal'), terminal: null },
        terminals
      )
    ).toBeUndefined()
    expect(
      getMobileTerminalTabHostAgentIdentity(terminalTab('Terminal'), [{ handle: 'pty-1' }])
    ).toBeUndefined()
  })
})

describe('resolveMobileTerminalTabOwnedAgentId', () => {
  it('excludes display-only terminal titles from behavioral authority', () => {
    expect(resolveMobileTerminalTabOwnedAgentId(terminalTab('✦ Gemini CLI'))).toBeNull()
    expect(
      resolveMobileTerminalTabOwnedAgentId(terminalTab('Terminal', { launchAgent: 'gemini' }))
    ).toBe('gemini')
  })
})

describe('getMobileSessionTabTitle', () => {
  it('strips leading agent decorations when an icon is shown', () => {
    expect(getMobileSessionTabTitle(terminalTab('✦ Gemini CLI'))).toBe('Gemini CLI')
  })

  it('falls back for glyph-only agent titles on mobile', () => {
    expect(getMobileSessionTabTitle(terminalTab('✳', { agentType: 'claude' }))).toBe('Terminal')
  })

  it('strips decorations for launch-owned terminal tabs before hooks arrive', () => {
    expect(getMobileSessionTabTitle(terminalTab('✳ working', { launchAgent: 'claude' }))).toBe(
      'working'
    )
  })

  it('keeps generic status titles unstripped when no agent identity is known', () => {
    expect(getMobileSessionTabTitle(terminalTab('✳ investigating'))).toBe('✳ investigating')
  })

  it('preserves browser title fallbacks after moving the helper out of the route', () => {
    const blankBrowserTab: Extract<MobileSessionTab, { type: 'browser' }> = {
      type: 'browser',
      id: 'browser-1',
      title: '',
      url: 'about:blank',
      browserWorkspaceId: 'browser-workspace-1',
      browserPageId: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true
    }

    expect(getMobileSessionTabTitle(blankBrowserTab)).toBe('New Browser')
  })

  it('labels structured agent-session tabs without terminal decoration rules', () => {
    expect(
      getMobileSessionTabTitle({
        type: 'agent-session',
        id: 'agent-tab-1',
        title: 'Codex Chat',
        sessionId: 'session-1',
        agent: 'codex',
        isActive: true
      })
    ).toBe('Codex Chat')
  })
})
