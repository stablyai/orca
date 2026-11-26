import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from './store.mjs'

test('the frozen plan survives a restart and stays bound to its original Commander, tenant and project', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-dispatch-replay-'))
  const path = join(directory, 'memory.db')
  let db = openStore(path)
  t.after(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const owner = {
    tenant: 'alice',
    actor: { type: 'commander', id: 'coordinator' },
    projectId: 'github:a/sdk'
  }
  const requestId = '00000000-1111-4444-aaaa-222222222222'
  const edit = {
    requestId,
    pageId: 'dispatch-' + requestId,
    projectId: owner.projectId,
    expectedVersion: 0,
    kind: 'decision',
    title: 'Planned worker launch',
    body: 'Use a small model.',
    links: [],
    replayPlan: {
      binding: 'a'.repeat(64),
      reason: 'Docs change',
      guidelines: 'Test the SDK.',
      model: 'small'
    }
  }
  db.write(owner, edit)
  db.close()
  db = openStore(path)
  assert.deepEqual(db.replayPlan(owner, requestId), {
    projectId: owner.projectId,
    pageId: edit.pageId,
    plan: edit.replayPlan
  })
  assert.equal(db.list(owner)[0].replayPlan, undefined)
  assert.throws(
    () => db.write(owner, { ...edit, replayPlan: { ...edit.replayPlan, model: 'new' } }),
    { status: 409 }
  )
  for (const other of [
    { ...owner, tenant: 'bob' },
    { ...owner, projectId: 'github:a/api' },
    { ...owner, actor: { type: 'commander', id: 'sibling' } }
  ]) {
    assert.throws(() => db.replayPlan(other, requestId), { status: 404 })
  }
  assert.throws(
    () => db.replayPlan({ ...owner, actor: { type: 'agent', id: 'coordinator' } }, requestId),
    { status: 403 }
  )
})
