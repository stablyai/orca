import { expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileSessionTab } from './mobile-session-route-types'
import { mobileSessionTabCardContent } from './mobile-session-tab-card-content'

it('matches per-kind tab details using the existing phone fields', () => {
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
  expect(content(terminal)).toMatchObject({
    title: 'Fix the tab title',
    programName: 'Claude',
    agentId: 'claude',
    state: 'working'
  })
  expect(
    content({ ...terminal, agentStatus: { ...agentStatus, restoredUnconfirmed: true } }).state
  ).toBeNull()
  expect(
    mobileSessionTabCardContent(terminal, undefined, 1001 + AGENT_STATUS_STALE_AFTER_MS).state
  ).toBeNull()
  expect(content({ ...terminal, title: 'Shell', agentStatus: null })).toMatchObject({
    title: 'Shell',
    programName: 'Terminal',
    agentId: null,
    state: null
  })
  expect(
    content({
      type: 'agent-session',
      id: 'c',
      title: '✳ Chat title',
      agent: 'codex',
      sessionId: 's',
      isActive: true
    })
  ).toMatchObject({ title: 'Chat title', programName: 'Codex', agentId: 'codex', state: null })
  for (const type of ['file', 'markdown'] as const) {
    expect(
      content({
        type,
        id: type,
        title: 'note.md',
        filePath: '/project/docs/note.md',
        relativePath: 'docs/note.md',
        isDirty: false,
        isActive: true,
        documentVersion: '1'
      })
    ).toMatchObject({
      title: 'note.md',
      detail: 'docs/note.md',
      programName: 'Editor',
      agentId: null
    })
  }
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
