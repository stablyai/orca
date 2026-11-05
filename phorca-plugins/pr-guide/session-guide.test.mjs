import assert from 'node:assert/strict'
import { it } from 'node:test'
import { checkAssociation, linkIfUnlinked, sessionLocalAccess } from './session-guide.mjs'

it('associates only the current repository and refuses another PR link', () => {
  const url = 'https://github.com/phocassoftware/fs-app/pull/2640'
  const worktree = { projectId: 'github:phocassoftware/fs-app', linkedPR: null }
  assert.equal(checkAssociation(url, worktree, 'session-123'), 2640)
  assert.throws(() => checkAssociation(url, { ...worktree, projectId: 'github:someone/else' }, 'session-123'), /different repository/)
  assert.throws(() => checkAssociation(url, { ...worktree, linkedPR: 2639 }, 'session-123'), /already linked/)
  assert.throws(() => checkAssociation(url, worktree, undefined), /session ID is required/)
})

it('rechecks the worktree before linking and refuses a newly linked PR', async () => {
  const worktree = { id: 'repo::path', projectId: 'github:phocassoftware/fs-app', linkedPR: null }
  const url = 'https://github.com/phocassoftware/fs-app/pull/2640'
  const calls = []
  const run = async (_file, args) => {
    calls.push(args)
    return JSON.stringify({ ok: true, result: { worktree: { ...worktree, linkedPR: 2639 } } })
  }
  await assert.rejects(linkIfUnlinked(url, worktree, 'session-123', run), /already linked/)
  assert.deepEqual(calls.map((args) => args[1]), ['show'])
})

it('links only after the fresh worktree check still finds no PR', async () => {
  const worktree = { id: 'repo::path', projectId: 'github:phocassoftware/fs-app', linkedPR: null }
  const calls = []
  await linkIfUnlinked('https://github.com/phocassoftware/fs-app/pull/2640', worktree, 'session-123', async (_file, args) => {
    calls.push(args)
    return args[1] === 'show'
      ? JSON.stringify({ ok: true, result: { worktree } })
      : JSON.stringify({ ok: true })
  })
  assert.deepEqual(calls.map((args) => args[1]), ['show', 'set'])
  assert.deepEqual(calls[1].slice(-3), ['--pr', '2640', '--json'])
})

it('keeps explicit session command terminal access in its worktree', async () => {
  const calls = []
  const access = sessionLocalAccess('repo::path', async (_file, args) => {
    calls.push(args)
    if (args[1] === 'list') return JSON.stringify({ ok: true, result: { terminals: [
      { handle: 'term_1', title: 'Agent', agentIdentity: 'codex', connected: true, writable: true },
      { handle: 'term_shell', title: 'Shell', agentIdentity: null, connected: true, writable: true }
    ] } })
    return JSON.stringify({ ok: true, result: { send: { accepted: true } } })
  })
  const sessions = await access.listSessions()
  assert.equal(sessions.length, 1)
  assert.deepEqual(await access.sendSession(sessions[0], 'Review this'), { accepted: true })
  assert.equal(calls[0][3], 'id:repo::path')
  assert.equal(calls[1][3], 'term_1')
})
