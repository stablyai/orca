import { expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import type { FollowUpTarget, FollowUpWorkspace } from '../../shared/pr-follow-ups/contracts'
import { installation } from './install-scheduling.test-fixture'
import { activityOverlaps } from './activity-journal'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'

it('reconciles unresolved discovery watches through global and project settings listeners', async () => {
  const h = installation(1, true)
  await h.flush()
  expect(h.handles).toHaveLength(0)
  h.global(true)
  await h.flush()
  expect(h.handles).toHaveLength(1)
  h.global(false)
  await h.flush()
  expect(h.handles[0]).toHaveBeenCalledOnce()
  h.project(true)
  await h.flush()
  expect(h.handles).toHaveLength(2)
  h.project(false)
  await h.flush()
  expect(h.handles[1]).toHaveBeenCalledOnce()
})

it.each([10, 100])(
  'coalesces reevaluation during awaited preparation without dropping %i spaced activity transitions',
  async (count) => {
    const h = installation(count)
    await h.flush()
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    h.prepare.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { agent: 'codex', surface: 'chat', target: { kind: 'existing', worktree: 'id:w0' } }
    })
    let sql = 0
    let rows = 0
    const histories = new Set<string>()
    const prepare = h.db.prepare.bind(h.db)
    vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      return new Proxy(statement, {
        get(owner, field) {
          if (field !== 'all' && field !== 'get' && field !== 'run') {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            sql++
            for (const arg of args) {
              if (typeof arg === 'string' && /^pr[0-9]+$/.test(arg)) {
                histories.add(arg)
              }
            }
            const result = statement[field](...args)
            if (field !== 'run') {
              rows += Array.isArray(result) ? result.length : result ? 1 : 0
            }
            return result
          }
        }
      })
    })
    vi.mocked(recoverFollowUpLaunch).mockClear()
    const reconcile = vi.spyOn(h.engine, 'reconcile')
    const live = vi.mocked(h.inputs.live)
    live.mockClear()
    h.observe(['unit'])
    await preparing
    for (let index = 0; index < count; index++) {
      h.status(index % 2 === 0, h.now + index + 10)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(reconcile.mock.calls.filter(([keys]) => keys && [...keys].length).length).toBe(1)
    release()
    await h.flush()
    const jobs = reconcile.mock.calls.filter(([keys]) => keys && [...keys].length)
    expect(jobs.length).toBeLessThanOrEqual(2)
    expect(jobs.every(([keys]) => [...keys!].every((key) => key === 'pr0'))).toBe(true)
    expect(live.mock.calls.length).toBeLessThanOrEqual(6)
    expect(h.prepare).toHaveBeenCalledOnce()
    expect(launchFollowUp).toHaveBeenCalledOnce()
    expect(recoverFollowUpLaunch).toHaveBeenCalledTimes(3)
    expect([...histories]).toEqual(['pr0'])
    expect(sql).toBeLessThan(count * 20 + 100)
    expect(rows).toBeLessThan(count * 20 + 100)
    const evidence = h.records.activityWindow('i0', 'pane-w0', h.now, h.now + count + 10)
    expect(
      new Set(evidence.filter((event) => event.kind === 'idle').map((event) => event.at)).size
    ).toBe(count / 2)
    expect(activityOverlaps(evidence, h.now + 11.5, h.now + 11.9)).toBe(false)
    expect(h.records.workingOverlap('pr0', h.now + 12, h.now + 13)).toBe(true)
  }
)

it('reconciles both old and new bindings while retaining unrelated reader handles', async () => {
  const h = installation(10)
  await h.flush()
  const reconcile = vi.spyOn(h.engine, 'reconcile')
  h.relink()
  await h.flush()
  expect(h.handles[0]).toHaveBeenCalledOnce()
  expect(h.handles.slice(1, 10).every((release) => release.mock.calls.length === 0)).toBe(true)
  expect(h.handles).toHaveLength(11)
  const launchInputs = vi.spyOn(h.inputs, 'launchInputs')
  const targetChanged = vi.spyOn(h.engine, 'targetChanged')
  h.unchanged()
  await h.flush()
  expect(launchInputs).not.toHaveBeenCalled()
  expect(targetChanged).not.toHaveBeenCalled()
  const keys = reconcile.mock.calls.flatMap(([keys]) => (keys ? [...keys] : []))
  expect([...new Set(keys)].sort()).toEqual(['new-pr', 'pr0'])
})

it.each(['chat', 'terminal'] as const)(
  'admits the synchronous initial %s snapshot before any projection',
  async (surface) => {
    const h = installation(1, false, surface, true)
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 12)).toBe(false)
    h.stream('pane-w0', true, h.now + 20)
    await h.flush()
    h.nextObservation('h2', h.now + 25)
    await h.flush()
    expect(h.records.pr('pr0')?.generation).toBe(0)
  }
)

it.each([
  ['chat', 10],
  ['chat', 100],
  ['terminal', 10],
  ['terminal', 100]
] as const)(
  'recovers late %s identity among %i retained PRs through an ordinary record commit without losing another session’s idle gap',
  async (surface, count) => {
    const h = installation(count, false, surface, false, true)
    await h.flush()
    await h.restart()
    let entered!: () => void
    let settle!: () => void
    const launching = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.mocked(launchFollowUp).mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => {
        settle = resolve
      })
      return { status: 'unconfirmed' }
    })
    h.observe(['unit'])
    await launching
    const action = h.records.latestAction('pr0')!
    const at = Date.now() + 1000
    const routed = vi.spyOn(h.engine, 'reconcile')
    h.stream('pane-w1', false, at)
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: ['pane-w1'],
        operationIds: ['old-pr1'],
        recordWorkspaceIds: ['w0']
      })
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      routed.mock.calls.filter(([keys]) => keys && [...keys].length).map(([keys]) => [...keys!])
    ).toEqual([['pr1', 'pr0']])
    // Both identities arrive while the operation is claimed, before any receipt identifies it.
    h.stream('pane-w0', false, at + 1)
    h.stream('late', true, at + 5)
    h.stream('other', false, at + 8)
    h.stream('late', false, at + 10)
    h.stream('late', true, at + 20)
    h.stream('other', false, at + 25)
    settle()
    await h.flush()
    vi.mocked(recoverFollowUpLaunch).mockImplementation(async (_runtime, candidate) =>
      candidate.operationId === action.operationId
        ? {
            status: 'accepted',
            identity:
              surface === 'chat' ? { surface, sessionId: 'late' } : { surface, paneKey: 'late' }
          }
        : { status: 'unconfirmed' }
    )
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: ['late'],
        recordWorkspaceIds: ['w0'],
        operationIds: [action.operationId]
      })
    )
    await h.flush()
    expect(h.records.action(action.actionKey)?.status).toBe('accepted')
    expect(h.records.workingOverlap('pr0', at + 15, at + 18)).toBe(false)
    expect(h.records.workingOverlap('pr0', at + 21, at + 28)).toBe(true)
    expect(launchFollowUp).toHaveBeenCalledOnce()
    expect(
      routed.mock.calls.every(
        ([keys]) => !keys || [...keys].every((key) => key === 'pr0' || key === 'pr1')
      )
    ).toBe(true)
  }
)

it.each([
  ['chat', 10],
  ['chat', 100],
  ['terminal', 10],
  ['terminal', 100]
] as const)(
  'bounds admission and fixed-window reads through the %s adapter with %i historical transitions',
  async (surface, count) => {
    const h = installation(count, false, surface)
    await h.flush()
    let rows = 0
    let actionWrites = 0
    let sql = 0
    const prepare = h.db.prepare.bind(h.db)
    vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      return new Proxy(statement, {
        get(owner, field) {
          if (!['get', 'all', 'run'].includes(String(field))) {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            sql++
            if (/INSERT INTO followup_action/.test(query)) {
              actionWrites++
            }
            const result = statement[field as 'all'](...args)
            if (field !== 'run') {
              rows += Array.isArray(result) ? result.length : result ? 1 : 0
            }
            return result
          }
        }
      })
    })
    // Ordinary unrelated stream and committed-record events must not load any obligation history.
    h.stream('unrelated', true, h.now, 'other-workspace')
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordIds: ['unrelated'],
        recordWorkspaceIds: ['other-workspace']
      })
    )
    await h.flush()
    expect(sql).toBe(0)
    for (let i = 0; i < count; i++) {
      h.stream('pane-w0', i % 2 === 0, h.now - 90 + i / 4)
    }
    // The append path has no reads or action rewrites, regardless of retained history.
    expect(rows).toBe(0)
    expect(actionWrites).toBe(0)
    expect(sql).toBe(count)
    await h.flush()
    h.stream('pane-w0', true, h.now + 10)
    h.stream('pane-w0', false, h.now + 20)
    rows = 0
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 15)).toBe(true)
    expect(rows).toBeLessThanOrEqual(3)
    rows = 0
    expect(h.records.workingOverlap('pr0', h.now + 21, h.now + 25)).toBe(false)
    expect(rows).toBeLessThanOrEqual(3)
    // A shared PR binding retains its evidence when one instance is deleted.
    h.records.bind('pr0', 'shared-instance')
    await h.engine.instanceDeleted('i0')
    expect(h.records.workingOverlap('pr0', h.now + 11, h.now + 15)).toBe(true)
  }
)

it.each([10, 100])(
  'finalizes shared-PR inventory membership once for %i additions, removals and resolution losses',
  async (count) => {
    const h = installation(1)
    await h.flush()
    const added = Array.from({ length: count }, (_, i) => ({
      ...h.targets[0]!,
      worktreeId: `new-w${i}`,
      instanceId: `new-i${i}`
    }))
    const spaces = added.map((t) => ({
      ...h.workspaces[0]!,
      worktreeId: t.worktreeId,
      instanceId: t.instanceId
    }))
    const stringify = JSON.stringify.bind(JSON)
    let keys = 0
    let groups = 0
    const originalIterator = Array.prototype[Symbol.iterator]
    // Count actual serialized membership keys and shared-group traversals at listener admission.
    const jsonSpy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (
        Array.isArray(value) &&
        value.every((v) => typeof v === 'string' && /^(new-w|w)/.test(v))
      ) {
        keys += value.length
      }
      return stringify(value, ...args)
    })
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this.length && this[0] && typeof this[0] === 'object' && 'prKey' in this[0]) {
        groups += this.length
      }
      return originalIterator.call(this)
    }
    const measure = (targets: FollowUpTarget[], workspaces: FollowUpWorkspace[]) => {
      keys = 0
      groups = 0
      h.inventory(targets, workspaces)
      expect(keys).toBeLessThanOrEqual((count + 1) * 2)
      expect(groups).toBeLessThanOrEqual((count + 1) * 12)
    }
    try {
      measure([...h.targets, ...added], [...h.workspaces, ...spaces])
      await h.flush()
      measure(h.targets.slice(0, 1), h.workspaces)
      await h.flush()
      measure([h.targets[0]!, ...added], h.workspaces)
      await h.flush()
      measure(h.targets.slice(0, 1), h.workspaces.slice(0, 1))
    } finally {
      jsonSpy.mockRestore()
      Array.prototype[Symbol.iterator] = originalIterator
    }
    await h.flush()
  }
)
