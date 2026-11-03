import assert from 'node:assert/strict'
import { it } from 'node:test'
import { checkAssociation } from './session-guide.mjs'

it('associates only the current repository and refuses another PR link', () => {
  const url = 'https://github.com/phocassoftware/fs-app/pull/2640'
  const worktree = { projectId: 'github:phocassoftware/fs-app', linkedPR: null }
  assert.equal(checkAssociation(url, worktree, 'session-123'), 2640)
  assert.throws(() => checkAssociation(url, { ...worktree, projectId: 'github:someone/else' }, 'session-123'), /different repository/)
  assert.throws(() => checkAssociation(url, { ...worktree, linkedPR: 2639 }, 'session-123'), /already linked/)
  assert.throws(() => checkAssociation(url, worktree, undefined), /session ID is required/)
})
