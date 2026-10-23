// Every main-side writer that rewrites a window-owned partition through the layout Loader and
// Serializer must hand a cross-host terminal's stamp back exactly as stored, never as a local tab.

import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { withChatTabChanges } from '../../runtime/agent-session-tab-layout'
import { buildRuntimeTerminalOrphanSession } from '../../runtime/runtime-terminal-orphan-session-adoption'
import { withOpenedServeBrowserTab } from '../../runtime/serve-browser-tab-layout'
import {
  admitPaneToSession,
  applyCommandToSession,
  withdrawPaneFromSession
} from './terminal-pane-admission'

const HOST = 'local'
const NEW_LEAF = leaf(8)

const STAMPS: [string, Partial<Tab>][] = [
  ['a valid stamp', { executionHostId: 'runtime:env-a', projectHostSetupId: 'setup-a' }],
  ['a numeric setup', { executionHostId: 'runtime:env-a', projectHostSetupId: 42 }],
  ['a null setup', { executionHostId: 'runtime:env-a', projectHostSetupId: null }],
  ['a stamp with no host', { projectHostSetupId: 'setup-a' }]
]

function stamped(stamp: Partial<Tab>): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: [
        { id: 'tab-local', leaves: [[leaf(1), 'pty-local']] },
        { id: 'tab-host', leaves: [[leaf(2), 'remote:env-a@@h1']], entry: stamp }
      ]
    }
  ])
  const hostEntry = session.unifiedTabs?.[GIT_KEY]?.find((entry) => entry.id === 'tab-host')
  if (hostEntry && !('executionHostId' in stamp)) {
    delete hostEntry.executionHostId
  }
  return JSON.parse(JSON.stringify(session))
}

const hostEntryOf = (session: WorkspaceSessionState | null) => {
  if (!session) {
    throw new Error('the writer reported no change')
  }
  return session.unifiedTabs?.[GIT_KEY]?.find((entry) => entry.id === 'tab-host')
}

const storedEntry = (session: WorkspaceSessionState) => hostEntryOf(session)

describe('main-side layout writers keep a cross-host terminal stamp', () => {
  it.each(STAMPS)('admitPaneToSession keeps %s', (_label, stamp) => {
    const stored = stamped(stamp)
    const change = admitPaneToSession(HOST, stored, {
      type: 'createTerminalTab',
      workspace: GIT_KEY,
      tabId: 'tab-new',
      leafId: NEW_LEAF
    })
    expect(change.value).toBe('admitted')
    expect(hostEntryOf(change.session)).toEqual(storedEntry(stored))
  })

  it.each(STAMPS)('withdrawPaneFromSession keeps %s', (_label, stamp) => {
    const stored = stamped(stamp)
    const admitted = admitPaneToSession(HOST, stored, {
      type: 'createTerminalTab',
      workspace: GIT_KEY,
      tabId: 'tab-new',
      leafId: NEW_LEAF
    }).session
    if (!admitted) {
      throw new Error('admission wrote nothing')
    }
    const change = withdrawPaneFromSession(HOST, admitted, {
      type: 'closePane',
      workspace: GIT_KEY,
      tabId: 'tab-new',
      leafId: NEW_LEAF
    })
    expect(change.value).toBeNull()
    expect(hostEntryOf(change.session)).toEqual(storedEntry(stored))
  })

  it.each(STAMPS)('applyCommandToSession keeps %s on the tab it splits', (_label, stamp) => {
    const stored = stamped(stamp)
    const change = applyCommandToSession(HOST, stored, {
      type: 'splitPane',
      workspace: GIT_KEY,
      tabId: 'tab-host',
      leafId: leaf(2),
      direction: 'vertical',
      newLeafId: NEW_LEAF
    })
    expect(change.value.ok).toBe(true)
    expect(hostEntryOf(change.session)).toEqual(storedEntry(stored))
  })

  it.each(STAMPS)('applyCommandToSession keeps %s on the entry it renames', (_label, stamp) => {
    const stored = stamped(stamp)
    const change = applyCommandToSession(HOST, stored, {
      type: 'renameTab',
      workspace: GIT_KEY,
      tabId: 'tab-host',
      kind: 'custom',
      title: 'Builder'
    })
    expect(change.value.ok).toBe(true)
    expect(hostEntryOf(change.session)).toEqual({ ...storedEntry(stored), customLabel: 'Builder' })
  })

  it.each(STAMPS)('withChatTabChanges keeps %s', (_label, stamp) => {
    const stored = stamped(stamp)
    const saved = withChatTabChanges(HOST, stored, GIT_KEY, [
      { open: { sessionId: 'chat-1', agent: 'claude', tabId: 'chat-tab-1' } }
    ])
    expect(hostEntryOf(saved)).toEqual(storedEntry(stored))
  })

  it.each(STAMPS)('withOpenedServeBrowserTab keeps %s', (_label, stamp) => {
    const stored = stamped(stamp)
    const saved = withOpenedServeBrowserTab(HOST, stored, {
      worktreeId: GIT_KEY,
      pageId: 'page-1',
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(hostEntryOf(saved)).toEqual(storedEntry(stored))
  })

  it.each(STAMPS)('buildRuntimeTerminalOrphanSession keeps %s', (_label, stamp) => {
    const stored = stamped(stamp)
    const saved = buildRuntimeTerminalOrphanSession({
      hostId: HOST,
      session: stored,
      sessionWorktreeId: GIT_KEY,
      worktreeId: GIT_KEY,
      request: { worktree: GIT_KEY, expectedTopologyRevision: 0, claims: [] },
      validated: [],
      topologyTabsById: new Map(),
      topologyGroups: [],
      getDisplayTitle: () => null
    })
    expect(hostEntryOf(saved)).toEqual(storedEntry(stored))
  })

  it('still names the partition host for an unstamped entry naming another host', () => {
    const stored = stamped({ executionHostId: 'runtime:env-a' })
    const change = admitPaneToSession(HOST, stored, {
      type: 'createTerminalTab',
      workspace: GIT_KEY,
      tabId: 'tab-new',
      leafId: NEW_LEAF
    })
    expect(hostEntryOf(change.session)?.executionHostId).toBe(HOST)
    expect(hostEntryOf(change.session)).not.toHaveProperty('projectHostSetupId')
  })
})
