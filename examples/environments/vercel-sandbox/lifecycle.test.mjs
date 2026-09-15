import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readPayload, verifyPayload } from './lifecycle.mjs'
import { validateConfig } from './configuration.mjs'
import { openJournal, atomicWrite, hash } from './journal.mjs'
import { Resources, intent } from './resource-lifecycle.mjs'

const auth = { token: 'test-token', teamId: 'team_test', projectId: 'prj_test' }
const config = {
  team: 'test',
  project: 'test',
  stateDirectory: join(tmpdir(), 'orca-test'),
  snapshotId: 'snap_base'
}
const missing = () =>
  Object.assign(new Error('missing'), { json: { error: { code: 'not_found' } } })
function setup() {
  let value = intent(config, auth)
  let box = {
    name: value.name,
    tags: { orcaOwner: value.owner },
    status: 'running',
    currentSnapshotId: 'snap_workspace',
    currentSession: () => ({ sessionId: 'session_test' }),
    listSessions: async () => ({ toArray: async () => [{ id: 'session_test' }] }),
    stop: async () => {
      box.status = 'stopped'
    },
    resume: async () => {
      box.status = 'running'
    },
    delete: async () => {
      box = null
    }
  }
  let snapshots = []
  const deletedSnapshots = new Set()
  const calls = []
  const journal = {
    get value() {
      return value
    },
    save(next) {
      value = next
    }
  }
  const api = {
    Sandbox: {
      create: async () => {
        calls.push('create')
        return box
      },
      get: async () => {
        calls.push('get')
        if (!box) {
          throw missing()
        }
        return box
      }
    },
    Snapshot: {
      list: async () => ({ toArray: async () => snapshots }),
      get: async ({ snapshotId }) => {
        calls.push(`snapshot:${snapshotId}`)
        if (deletedSnapshots.has(snapshotId)) {
          throw missing()
        }
        return {
          snapshotId,
          status: 'created',
          sourceSessionId: 'session_test',
          delete: async () => {
            deletedSnapshots.add(snapshotId)
            calls.push(`delete:${snapshotId}`)
            snapshots = snapshots.filter((s) => s.id !== snapshotId)
          }
        }
      }
    }
  }
  return {
    journal,
    api,
    calls,
    get box() {
      return box
    },
    set snapshots(value) {
      snapshots = value
    },
    resources: new Resources(auth, journal, api)
  }
}
test('reject malformed, oversized, wrong-provider and wrong-mode lifecycle payloads', async () => {
  for (const input of [
    '{',
    'x'.repeat(1024 * 1024 + 1),
    JSON.stringify({ schemaVersion: 1, mode: 'resume' })
  ]) {
    await assert.rejects(readPayload(Readable.from([input]), 'destroy'))
  }
  const data = {
    provider: 'vercel-sandbox',
    resourceId: 'name',
    owner: 'owner',
    journalId: randomUUID()
  }
  const payload = { schemaVersion: 1, mode: 'destroy', recipeResult: { userData: data } }
  assert.deepEqual(await readPayload(Readable.from([JSON.stringify(payload)]), 'destroy'), data)
  assert.throws(() => verifyPayload(data, { name: 'other' }), /ownership journal/)
})
test('only credential-free HTTPS clones and pinned commits are accepted', () => {
  for (const repoUrl of [
    'file:///tmp/repo',
    'ssh://host/path',
    'https://token@host/repo',
    'https://host/repo?token=x'
  ]) {
    assert.throws(() => validateConfig({ ...config, repoUrl }))
  }
  for (const repoRef of ['--upload-pack=evil', 'main; touch /tmp/x', '$(echo x)', '../main']) {
    assert.throws(() => validateConfig({ ...config, repoRef }))
  }
  assert.equal(
    validateConfig({ ...config, repoRef: 'a'.repeat(40), repoUrl: 'https://host/repo.git' }).repoRef
      .length,
    40
  )
})
test('local journals lock, refuse stale writes, and preserve the newer bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-journal-'))
  const id = randomUUID()
  try {
    const journal = openJournal(directory, id, { phase: 'intent' })
    journal.save({ phase: 'creating' })
    assert.throws(() => openJournal(directory, id), /EEXIST/)
    const path = join(directory, `${id}.json`)
    const before = readFileSync(path)
    assert.throws(() => atomicWrite(path, 'bad', hash('stale')), /STALE_PRECONDITION/)
    assert.deepEqual(readFileSync(path), before)
    journal.close()
    assert.throws(() => openJournal(directory, '../../etc/passwd'), /Invalid journal/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('create records intent before provider invocation; collision cleanup cannot delete a foreign resource', async () => {
  const t = setup()
  t.api.Sandbox.create = async () => {
    assert.equal(t.journal.value.phase, 'creating')
    throw new Error('collision')
  }
  t.box.tags.orcaOwner = 'foreign'
  await assert.rejects(t.resources.create(config), /collision/)
  await assert.rejects(t.resources.destroy(), /ownership mismatch/)
  assert.ok(t.box)
})
test('ambiguous create is reconciled by exact owner and all sessions', async () => {
  const t = setup()
  t.api.Sandbox.create = async () => {
    throw new Error('response lost')
  }
  await assert.rejects(t.resources.create(config), /response lost/)
  t.snapshots = [{ id: 'snap_owned', sourceSessionId: 'session_test' }]
  await t.resources.destroy()
  assert.equal(t.journal.value.phase, 'deleted')
  assert.ok(t.calls.includes('delete:snap_owned'))
})
test('cleanup failure preserves journal and can be retried after an ambiguous delete', async () => {
  const t = setup()
  await t.resources.create(config)
  const realDelete = t.box.delete
  t.box.delete = async () => {
    await realDelete()
    throw new Error('delete response lost')
  }
  t.snapshots = [{ id: 'snap_owned', sourceSessionId: 'session_test' }]
  await assert.rejects(t.resources.destroy(), /response lost/)
  assert.deepEqual(t.journal.value.snapshots, ['snap_owned'])
  await t.resources.destroy()
  await t.resources.destroy()
  assert.equal(t.journal.value.phase, 'deleted')
})
test('suspend is repeatable and requires a ready recovery snapshot', async () => {
  const t = setup()
  await t.resources.create(config)
  await t.resources.suspend()
  await t.resources.suspend()
  assert.equal(t.journal.value.phase, 'suspended')
  t.box.currentSnapshotId = null
  await assert.rejects(t.resources.suspend(), /recovery state/)
})
test('resume never creates a replacement when sandbox or snapshot is missing', async () => {
  const t = setup()
  await t.box.delete()
  await assert.rejects(t.resources.resume(), /cannot create a replacement/)
  assert.ok(!t.calls.includes('create'))
  const u = setup()
  u.box.status = 'stopped'
  u.box.currentSnapshotId = config.snapshotId
  await assert.rejects(u.resources.resume(), /recovery snapshot missing/)
  assert.ok(!u.calls.includes('create'))
})
test('snapshot ownership and retained bases fence cleanup', async () => {
  const t = setup()
  await t.resources.create(config)
  t.snapshots = [{ id: 'snap_foreign', sourceSessionId: 'foreign' }]
  await assert.rejects(t.resources.destroy(), /unrecognized source session/)
  assert.ok(t.box)
  t.snapshots = [
    { id: 'snap_base', sourceSessionId: 'session_test' },
    { id: 'snap_retained', sourceSessionId: 'session_test' }
  ]
  t.resources.save({ retained: ['snap_retained'] })
  await t.resources.destroy()
  assert.ok(!t.calls.some((c) => c.startsWith('delete:')))
})

test('an absent ambiguous create is not falsely marked cleaned up', async () => {
  const t = setup()
  await t.box.delete()
  await assert.rejects(t.resources.destroy(), /Creation outcome unknown/)
  assert.notEqual(t.journal.value.phase, 'deleted')
})
test('resume rejects an unowned recovery snapshot before starting a session', async () => {
  const t = setup()
  t.box.status = 'stopped'
  t.api.Snapshot.get = async () => ({ status: 'created', sourceSessionId: 'foreign' })
  await assert.rejects(t.resources.resume(), /Recovery snapshot ownership mismatch/)
  assert.equal(t.box.status, 'stopped')
})
test('cleanup verifies exact snapshot IDs after the name-filtered listing disappears', async () => {
  const t = setup()
  await t.resources.create(config)
  t.snapshots = [{ id: 'snap_owned', sourceSessionId: 'session_test' }]
  t.api.Snapshot.get = async () => ({
    status: 'created',
    sourceSessionId: 'session_test',
    delete: async () => {
      t.snapshots = []
    }
  })
  await assert.rejects(t.resources.destroy(), /Snapshot deletion unconfirmed/)
  assert.equal(t.journal.value.phase, 'deleting')
})

test('cleanup accepts already deleted snapshot tombstones without deleting them again', async () => {
  const t = setup()
  await t.resources.create(config)
  t.snapshots = [{ id: 'snap_deleted', sourceSessionId: 'session_test', status: 'deleted' }]
  t.api.Snapshot.get = async () => ({
    status: 'deleted',
    sourceSessionId: 'session_test',
    delete: async () => {
      throw new Error('already deleted')
    }
  })
  await t.resources.destroy()
  await t.resources.destroy()
  assert.equal(t.journal.value.phase, 'deleted')
})
