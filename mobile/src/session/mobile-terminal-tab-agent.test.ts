import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/types'
import type { MobileSessionTab } from '../../app/h/[hostId]/session/mobile-session-route-types'
import {
  getMobileSessionTabTitle,
  resolveMobileTerminalTabAgentId
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
})
