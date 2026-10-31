import { expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileSessionTab } from './mobile-session-route-types'
import { mobileSessionTabCardContent } from './mobile-session-tab-card-content'

it('preserves glyph-only agent titles and derives the kind-aware empty chat label', () => {
  const terminal: Extract<MobileSessionTab, { type: 'terminal' }> = {
    type: 'terminal',
    id: 't',
    title: '✳',
    launchAgent: 'claude',
    terminal: 'pty',
    isActive: true
  }
  const title = (tab: MobileSessionTab) => mobileSessionTabCardContent(tab, undefined, 1000).title
  expect(title(terminal)).toBe('✳')
  expect(
    title({
      type: 'agent-session',
      id: 'c',
      title: '',
      agent: 'codex',
      sessionId: 's',
      isActive: true
    })
  ).toBe('Chat')
})

it('hides unconfirmed and stale status and handles redacted and blank browser URLs', () => {
  const agentStatus: AgentStatusEntry = {
    state: 'working',
    agentType: 'claude',
    paneKey: 't:l',
    prompt: '',
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: []
  }
  const terminal: Extract<MobileSessionTab, { type: 'terminal' }> = {
    type: 'terminal',
    id: 't',
    title: '✳ Fix the tab title',
    terminal: 'pty',
    isActive: true,
    agentStatus
  }
  const content = (tab: MobileSessionTab) => mobileSessionTabCardContent(tab, undefined, 1000)
  expect(
    content({ ...terminal, agentStatus: { ...agentStatus, restoredUnconfirmed: true } }).state
  ).toBeNull()
  expect(
    mobileSessionTabCardContent(terminal, undefined, 1001 + AGENT_STATUS_STALE_AFTER_MS).state
  ).toBeNull()
  const browser: Extract<MobileSessionTab, { type: 'browser' }> = {
    browserWorkspaceId: 'w',
    browserPageId: 'p',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    type: 'browser',
    id: 'b',
    title: 'Search results',
    url: 'https://kagi.com/search?token=private&q=orca',
    isActive: true
  }
  expect(content(browser)).toMatchObject({
    title: 'Search results',
    programName: 'kagi.com/search?q=orca',
    agentId: null
  })
  expect(content({ ...browser, title: '', url: 'about:blank' })).toMatchObject({
    title: 'New Browser',
    programName: 'Browser'
  })
})
