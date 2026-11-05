import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-write-rollback'

function session(map?: WorkspaceSessionState['activeTabIdByWorktree']): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), activeTabIdByWorktree: map }
}

it('removes only its own addition when an optional map was previously absent', () => {
  const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(
    session(),
    session({ closing: 'old-tab' }),
    session({ closing: 'old-tab', other: 'new-tab' })
  )
  expect(restored.activeTabIdByWorktree).toEqual({ other: 'new-tab' })
})

it('restores a removed map entry without overwriting a concurrent addition', () => {
  const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(
    session({ closing: 'old-tab' }),
    session(),
    session({ other: 'new-tab' })
  )
  expect(restored.activeTabIdByWorktree).toEqual({ closing: 'old-tab', other: 'new-tab' })
})

it('preserves a newer value for a restored entry', () => {
  const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(
    session({ closing: 'old-tab' }),
    session(),
    session({ closing: 'new-tab' })
  )
  expect(restored.activeTabIdByWorktree).toEqual({ closing: 'new-tab' })
})

it('does not resurrect a map another writer removed', () => {
  const current = session()
  const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(
    session({ closing: 'old-tab' }),
    session({ closing: 'edited-tab' }),
    current
  )
  expect(restored).toBe(current)
})
