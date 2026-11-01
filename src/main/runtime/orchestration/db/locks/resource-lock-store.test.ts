import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

describe('OrchestrationDb resource locks & collaboration board', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('FIFO resource locks', () => {
    it('acquires an unheld resource lock immediately at position 0 and queues subsequent callers in FIFO order', () => {
      const d = createDb()
      const first = d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_a',
        reason: 'Landing T434',
        ttlMs: 60_000,
        nowMs: 1_000
      })
      expect(first.position).toBe(0)
      expect(first.lock.status).toBe('held')
      expect(first.holder.owner_handle).toBe('term_agent_a')

      const second = d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_b',
        reason: 'Landing T435',
        ttlMs: 60_000,
        nowMs: 1_100
      })
      expect(second.position).toBe(1)
      expect(second.lock.status).toBe('queued')
      expect(second.holder.owner_handle).toBe('term_agent_a')

      const third = d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_c',
        reason: 'Landing T557',
        ttlMs: 60_000,
        nowMs: 1_200
      })
      expect(third.position).toBe(2)

      const listed = d.listResourceLocks({ resourceKey: 'land:w0m', nowMs: 1_250 })
      expect(listed.map((row) => [row.owner_handle, row.status, row.position])).toEqual([
        ['term_agent_a', 'held', 0],
        ['term_agent_b', 'queued', 1],
        ['term_agent_c', 'queued', 2]
      ])
    })

    it('promotes the next FIFO waiter when the current holder releases the lock', () => {
      const d = createDb()
      d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_a',
        ttlMs: 60_000,
        nowMs: 1_000
      })
      d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_b',
        ttlMs: 45_000,
        nowMs: 1_100
      })

      const released = d.releaseResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_agent_a',
        nowMs: 2_000
      })
      expect(released.released).toBe(true)
      expect(released.promoted?.owner_handle).toBe('term_agent_b')
      expect(released.promoted?.status).toBe('held')
      expect(released.promoted?.acquired_at_ms).toBe(2_000)
      expect(released.promoted?.expires_at_ms).toBe(47_000)
    })

    it('expires a stale held lock and promotes the oldest queued waiter on the next check', () => {
      const d = createDb()
      d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_crashed',
        ttlMs: 5_000,
        nowMs: 1_000
      })
      d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_waiter',
        ttlMs: 10_000,
        nowMs: 1_500
      })

      const promoted = d.acquireResourceLock({
        resourceKey: 'land:w0m',
        ownerHandle: 'term_waiter',
        ttlMs: 10_000,
        nowMs: 6_500
      })
      expect(promoted.position).toBe(0)
      expect(promoted.lock.status).toBe('held')
      expect(promoted.lock.owner_handle).toBe('term_waiter')
    })
  })

  describe('collaboration board entries', () => {
    it('posts, lists, claims, and prevents conflicting double-claims on board entries', () => {
      const d = createDb()
      const taskEntry = d.postBoardEntry({
        scopeKey: 'w0m',
        kind: 'task',
        title: 'Rebase feat/obsidian-ofm-engine onto upstream/main',
        body: 'Needs conflict resolution in markdown-preview.css',
        authorHandle: 'term_coord',
        nowMs: 1_000
      })
      expect(taskEntry.status).toBe('open')
      expect(taskEntry.assignee_handle).toBeNull()

      const claimed = d.claimBoardEntry({
        id: taskEntry.id,
        assigneeHandle: 'term_agent_a',
        nowMs: 1_500
      })
      expect(claimed.status).toBe('claimed')
      expect(claimed.assignee_handle).toBe('term_agent_a')

      expect(() =>
        d.claimBoardEntry({
          id: taskEntry.id,
          assigneeHandle: 'term_agent_b',
          nowMs: 1_600
        })
      ).toThrow(/already claimed by term_agent_a/)

      const completed = d.claimBoardEntry({
        id: taskEntry.id,
        assigneeHandle: 'term_agent_a',
        status: 'completed',
        nowMs: 2_000
      })
      expect(completed.status).toBe('completed')

      const entries = d.listBoardEntries({ scopeKey: 'w0m', status: 'completed' })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.id).toBe(taskEntry.id)
    })
  })
})
