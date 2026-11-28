import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, chmod, symlink, readFile, lstat, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_REX_RECORDS, RexSessionStore } from './rex-session-store'
import { verifyRexIdentity, type RexSessionRecord } from './rex-session-record'

function record(): RexSessionRecord {
  return {
    version: 1,
    backend: 'rex-local',
    id: `rex-${randomUUID()}`,
    incarnationId: randomUUID(),
    sessionId: `session:${randomUUID()}`,
    blockId: `block:${randomUUID()}`,
    server: { host_id: 'test-host', instance_id: 'test-instance' },
    rootPid: 123,
    cwd: '/tmp'
  }
}

describe.skipIf(process.platform === 'win32')('Rex session record', () => {
  it('does not create a Rex profile or journal during unused-backend inventory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-unused-test-'))
    try {
      const profile = join(dir, 'rex-live-pty')
      const store = new RexSessionStore(profile)
      expect(await store.pendingFreshIds()).toEqual([])
      expect(await store.list()).toEqual([])
      expect(await store.list({ ptyIds: [record().id] })).toEqual([])
      expect(await store.recoverFresh(record().id, async () => true)).toBe(false)
      await expect(lstat(profile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists exclusively across instances, fences stale identity, and removes exact record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-record-test-'))
    try {
      const r = record()
      const store = new RexSessionStore(dir)
      await store.save(r)
      const next = new RexSessionStore(dir)
      expect(await next.read(r.id, r.incarnationId)).toEqual(r)
      await expect(next.save({ ...r, rootPid: 456 })).rejects.toThrow()
      await expect(next.read(r.id, randomUUID())).rejects.toThrow('incarnation mismatch')
      await expect(next.read('../escape', r.incarnationId)).rejects.toThrow()
      await expect(next.remove(r.id, randomUUID())).rejects.toThrow('incarnation mismatch')
      expect(JSON.parse(await readFile(join(dir, `${r.id}.json`), 'utf8'))).toEqual(r)
      await next.remove(r.id, r.incarnationId)
      await expect(next.read(r.id, r.incarnationId)).rejects.toThrow()
      await next.remove(r.id, r.incarnationId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('publishes only one competing record and never treats invalid contents as absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-record-publish-test-'))
    try {
      const first = record()
      const second = { ...first, incarnationId: randomUUID() }
      const store = new RexSessionStore(dir)
      const outcomes = await Promise.allSettled([
        store.save(first),
        new RexSessionStore(dir).save(second)
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      const winner = outcomes[0].status === 'fulfilled' ? first : second
      expect(await store.read(first.id)).toEqual(winner)
      expect(await readdir(dir)).toEqual([`${first.id}.json`])
      await writeFile(join(dir, `${first.id}.json`), Buffer.alloc(16 * 1024 + 1))
      await expect(store.reserveFresh(first.id)).rejects.toThrow('Unsafe')
      await expect(store.list({ ptyIds: [first.id] })).rejects.toThrow('Unsafe')
      await expect(store.remove(first.id, winner.incarnationId)).rejects.toThrow('Unsafe')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fences an unresolved launch across controllers and does not equate it with absence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-fresh-test-'))
    try {
      const r = record()
      const first = new RexSessionStore(dir)
      const second = new RexSessionStore(dir)
      const release = await first.reserveFresh(r.id)
      await expect(second.reserveFresh(r.id)).rejects.toThrow('launch outcome unknown')
      await expect(second.read(r.id)).rejects.toThrow('launch outcome unknown')
      await expect(second.list()).rejects.toThrow('complete inventory unavailable')
      expect(await second.list({ ptyIds: [record().id] })).toEqual([])
      expect(await second.list({ worktreeId: 'unrelated' })).toEqual([])
      await first.save(r)
      await expect(second.read(r.id)).rejects.toThrow('launch outcome unknown')
      await release.release()
      expect(await second.read(r.id)).toEqual(r)
      await expect(second.reserveFresh(r.id)).rejects.toThrow('identity already persisted')
      expect(await second.list()).toEqual([r])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses capacity overflow before dispatch even across concurrent reservers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-capacity-test-'))
    try {
      const store = new RexSessionStore(dir)
      const records = Array.from({ length: MAX_REX_RECORDS - 1 }, record)
      for (const entry of records) {
        await store.save(entry)
      }
      const attempts = await Promise.allSettled([
        store.reserveFresh(record().id),
        new RexSessionStore(dir).reserveFresh(record().id)
      ])
      const reserved = attempts.filter((entry) => entry.status === 'fulfilled')
      expect(reserved.length).toBeLessThanOrEqual(1)
      for (const entry of reserved) {
        await entry.value.release()
      }
      const release = await store.reserveFresh(record().id)
      await expect(store.reserveFresh(record().id)).rejects.toThrow('capacity')
      await release.release()
      expect(await store.list()).toHaveLength(MAX_REX_RECORDS - 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects insecure permissions and symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex-record-test-'))
    try {
      const r = record()
      const store = new RexSessionStore(dir)
      await store.save(r)
      const other = `rex-${randomUUID()}`
      await symlink(join(dir, `${r.id}.json`), join(dir, `${other}.json`))
      await expect(store.read(other, r.incarnationId)).rejects.toThrow()
      await chmod(join(dir, `${r.id}.json`), 0o644)
      await expect(store.read(r.id, r.incarnationId)).rejects.toThrow('Unsafe')
      await chmod(dir, 0o755)
      await expect(store.save(record())).rejects.toThrow('not private')
      await expect(store.read(r.id)).rejects.toThrow('not private')
      await expect(store.remove(r.id, r.incarnationId)).rejects.toThrow('not private')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects changed host, server run, and root process', () => {
    const r = record()
    expect(() => verifyRexIdentity(r, r.server, r.rootPid)).not.toThrow()
    expect(() => verifyRexIdentity(r, { ...r.server, host_id: 'different' }, r.rootPid)).toThrow(
      'server identity'
    )
    expect(() =>
      verifyRexIdentity(r, { ...r.server, instance_id: 'different' }, r.rootPid)
    ).toThrow('server identity')
    expect(() => verifyRexIdentity(r, r.server, 456)).toThrow('process identity')
  })
})
