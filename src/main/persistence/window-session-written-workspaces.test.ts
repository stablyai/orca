import { expect, it, vi } from 'vitest'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { windowViewPatchForMain } from './window-save-view'
import { windowWrittenWorkspaces } from './window-session-written-workspaces'

vi.mock('../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))

it('names only the row whose scrollback a whole-field window save changes', () => {
  let stored = emptySession()
  for (const [index, key] of ['repo-1::/a', 'repo-1::/b', 'repo-1::/c'].entries()) {
    stored = addWorkspace(stored, key, [
      { id: `group-${index}`, tabs: [{ id: `tab-${index}`, leaves: [[leaf(index + 1)]] }] }
    ])
  }
  const sent = {
    activeWorktreeId: 'repo-1::/b',
    terminalLayoutsByTabId: {
      ...stored.terminalLayoutsByTabId,
      'tab-1': { ...stored.terminalLayoutsByTabId['tab-1']!, buffersByLeafId: { [leaf(2)]: 'ls' } }
    }
  }

  const { patch, touched } = windowViewPatchForMain(stored, sent, null)

  expect(windowWrittenWorkspaces(stored, patch, touched!, undefined)).toEqual({
    workspaces: new Set(),
    refs: new Set(['row:tab-1'])
  })
})
