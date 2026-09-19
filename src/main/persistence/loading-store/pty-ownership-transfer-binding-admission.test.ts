import { expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { inspectPtyOwnershipTransferBindingAdmission as inspect } from './pty-ownership-transfer-binding-admission'

const binding = {
  worktreeId: 'folder:destination',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'terminal',
  incarnationId: 'incarnation'
}
const sibling = '22222222-2222-4222-8222-222222222222'
function emptySession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}
function published() {
  const session = emptySession()
  session.tabsByWorktree[binding.worktreeId] = [
    createMinimalPersistedTerminalTab({ ...binding, existingTabCount: 0 })
  ]
  session.terminalLayoutsByTabId[binding.tabId] = {
    root: { type: 'leaf', leafId: binding.leafId },
    activeLeafId: binding.leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [binding.leafId]: binding.ptyId }
  }
  session.terminalPtyIncarnationsByPaneKey = {
    [`${binding.tabId}:${binding.leafId}`]: binding.incarnationId
  }
  return session
}

it('reports only vacant session binding, not destination catalog membership', () => {
  const session = emptySession()
  const before = structuredClone(session)
  expect(inspect(session, binding)).toBe('absent')
  expect(session).toEqual(before)
})

it('recognizes an exact single-pane retry without altering saved state', () => {
  const session = published()
  const before = structuredClone(session)
  expect(inspect(session, binding)).toBe('published')
  expect(session).toEqual(before)
})

it('refuses a second terminal in an existing tab without reservation authority', () => {
  const session = published()
  const before = structuredClone(session)
  expect(
    inspect(session, {
      ...binding,
      leafId: sibling,
      ptyId: 'second',
      incarnationId: 'second-incarnation'
    })
  ).toBe('conflict')
  expect(session).toEqual(before)
})

it('does not reinterpret a split layout as an exact single-pane publication retry', () => {
  const session = published()
  const layout = session.terminalLayoutsByTabId[binding.tabId]
  layout.root = {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: binding.leafId },
    second: { type: 'leaf', leafId: sibling }
  }
  layout.ptyIdsByLeafId![sibling] = 'second'
  const before = structuredClone(session)
  expect(inspect(session, binding)).toBe('conflict')
  expect(session).toEqual(before)
})
