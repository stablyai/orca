import { expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'

it('resolves saved spellings and sees keys added by replacing a map', () => {
  const session = { tabsByWorktree: { 'repo::/a/b/': [] } } as unknown as WorkspaceSessionState
  expect(resolveTerminalSessionWorktreeId(session, 'repo::/a/b')).toBe('repo::/a/b/')
  expect(resolveTerminalSessionWorktreeId(session, 'repo::/c')).toBe('repo::/c')
  session.activeTabIdByWorktree = { 'repo::/a//b': null }
  expect(resolveTerminalSessionWorktreeId(session, 'repo::/a/b')).toBeNull()
})
