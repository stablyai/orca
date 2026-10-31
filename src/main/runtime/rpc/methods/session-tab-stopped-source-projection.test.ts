import { expect, it } from 'vitest'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { StoppedSwitchSourceFact } from '../../../../shared/stopped-switch-source'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { projectSessionTabsForClient } from './session-tabs-inventory'

const forPhone = (snapshot: RuntimeMobileSessionTabsResult) =>
  projectSessionTabsForClient(snapshot, 'mobile', NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES)

// A failed switch keeps its stopped pane: paired desktops show it stopped from main's fact, and a
// phone, which has no stopped state, sees that pane gone as when a terminal exits.

const fact: StoppedSwitchSourceFact = {
  ptyId: 'pty-stopped',
  incarnationId: 'incarnation-1',
  agent: 'claude',
  providerSessionId: 'claude-conversation'
}

function terminal(tabId: string, leafId: string, isActive = false, stopped = false) {
  return {
    type: 'terminal' as const,
    id: `${tabId}::${leafId}`,
    parentTabId: tabId,
    leafId,
    title: 'Terminal',
    isActive,
    status: 'ready' as const,
    terminal: `handle-${tabId}-${leafId}`,
    ...(stopped ? { stoppedSwitchSource: fact } : {})
  }
}

function frame(tabs: RuntimeMobileSessionClientTab[], tabOrder: string[], active: string) {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: active,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-1', activeTabId: 'stopped', tabOrder, recentTabIds: tabOrder }],
    tabs
  } satisfies RuntimeMobileSessionTabsResult
}

const chat = {
  type: 'agent-session' as const,
  id: 'chat',
  sessionId: 'chat-session',
  agent: 'claude',
  title: 'Claude',
  isActive: false
}

it('drops a stopped pane for a phone, as an exit does, and keeps it for a paired desktop', () => {
  const shown = frame(
    [terminal('stopped', 'leaf-1', true, true), terminal('other', 'leaf-1'), chat],
    ['stopped', 'other', 'chat'],
    'stopped::leaf-1'
  )

  const phone = forPhone(shown)
  expect(phone.tabs.map((tab) => tab.id)).toEqual(['other::leaf-1', 'chat'])
  expect(phone.tabGroups?.[0]?.tabOrder).toEqual(['other', 'chat'])
  // The phone's selection falls back exactly as when a terminal it showed exits.
  expect(phone.activeTabId).toBe('other::leaf-1')
  expect(phone.tabs.find((tab) => tab.isActive)?.id).toBe('other::leaf-1')

  const desktop = projectSessionTabsForClient(
    shown,
    'runtime',
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  expect(desktop.tabs.find((tab) => tab.id === 'stopped::leaf-1')).toMatchObject({
    status: 'ready',
    stoppedSwitchSource: fact
  })
  expect(desktop.tabGroups?.[0]?.tabOrder).toEqual(['stopped', 'other', 'chat'])

  // A desktop retry replaces the stopped tab with the chat at its slot: the phone shows the chat.
  const replaced = frame(
    [{ ...chat, id: 'retry-chat', sessionId: 'retry-session', isActive: true }, chat],
    ['retry-chat', 'chat'],
    'retry-chat'
  )
  const phoneAfterRetry = forPhone(replaced)
  expect(phoneAfterRetry.tabs.map((tab) => tab.id)).toEqual(['retry-chat', 'chat'])
  expect(phoneAfterRetry.activeTabId).toBe('retry-chat')
})

it('keeps a split tab for a phone when only one of its panes stopped', () => {
  const split = frame(
    [terminal('split', 'leaf-1', true, true), terminal('split', 'leaf-2')],
    ['split'],
    'split::leaf-1'
  )
  const phone = forPhone(split)
  expect(phone.tabs.map((tab) => tab.id)).toEqual(['split::leaf-2'])
  expect(phone.tabGroups?.[0]?.tabOrder).toEqual(['split'])
})

it('passes a frame with no stopped pane through unchanged, however many rows', () => {
  for (const count of [50, 500]) {
    const rows = Array.from({ length: count }, (_, i) => terminal(`tab-${i}`, 'leaf-1', i === 0))
    const plain = frame(
      rows,
      rows.map((row) => row.parentTabId),
      'tab-0::leaf-1'
    )
    expect(forPhone(plain).tabs).toBe(plain.tabs)
  }
})
