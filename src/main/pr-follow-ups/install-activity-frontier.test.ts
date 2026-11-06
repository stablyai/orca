import { expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type Database from '../sqlite/sync-database'
import { installation } from './install-scheduling.test-fixture'
import { launchFollowUp, recoverFollowUpLaunch } from './launch'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'

it.each([10, 100])(
  'selects only the temporal session frontier before materializing %i ended historical actions',
  async (count) => {
    const h = installation(1)
    await h.flush()
    const active = h.records.action('active-pr0')!
    for (let index = 0; index < count; index++) {
      h.records.saveAction({
        ...active,
        actionKey: `ended-${index}`,
        operationId: `ended-op-${index}`,
        paneKey: `ended-pane-${index}`,
        sessionStartedAt: h.now - 1000,
        sessionEndedAt: h.now - 500
      })
    }
    // Ended-inside-window work is relevant, unlike ended-before-window or future-start work.
    h.records.saveAction({
      ...active,
      actionKey: 'ended-inside',
      operationId: 'ended-inside-op',
      paneKey: 'ended-inside-pane',
      sessionStartedAt: h.now - 50,
      sessionEndedAt: h.now + 20
    })
    h.records.saveAction({
      ...active,
      actionKey: 'future',
      operationId: 'future-op',
      paneKey: 'future-pane',
      sessionStartedAt: h.now + 10000
    })
    h.stream('pane-w0', false, h.now + 1)
    await h.flush()
    let candidateRead = false
    let extractions = 0
    let candidates = 0
    const plans: string[] = []
    const sqlite: DatabaseSync = Reflect.get(h.db, 'db')
    sqlite.function('json_extract', { deterministic: true }, (json, path) => {
      if (candidateRead) {
        extractions++
      }
      const value = JSON.parse(String(json))[String(path).slice(2)]
      return value === undefined
        ? null
        : typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : value
    })
    const prepare = h.db.prepare.bind(h.db)
    vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
      const statement = prepare(query)
      if (!query.includes('INDEXED BY followup_action_live_window')) {
        return statement
      }
      return new Proxy(statement, {
        get(owner, field) {
          if (field !== 'all') {
            return Reflect.get(owner, field)
          }
          return (...args: Database.BindValue[]) => {
            candidateRead = true
            try {
              plans.push(
                ...prepare(`EXPLAIN QUERY PLAN ${query}`)
                  .all(...args)
                  .map((row) => String(row.detail))
              )
              const rows = statement.all(...args)
              candidates += rows.length
              return rows
            } finally {
              candidateRead = false
            }
          }
        }
      })
    })
    h.nextObservation('h2', h.now + 30)
    await h.flush()
    expect(candidates).toBe(2)
    expect(
      plans
        .filter((detail) => detail.includes('followup_action_'))
        .every((detail) => detail.includes('SEARCH') && detail.includes('<expr>'))
    ).toBe(true)
    expect(extractions).toBeLessThanOrEqual(20)
    expect(h.records.pr('pr0')?.generation).toBe(0)
    candidates = 0
    extractions = 0
    h.nextObservation('h3', h.now + 40)
    await h.flush()
    expect(candidates).toBe(1)
    expect(extractions).toBeLessThanOrEqual(10)
    expect(h.records.pr('pr0')?.generation).toBe(1)
  }
)

it.each([10, 100])('adds no evidence rows for %i unchanged reconcile ticks', async (count) => {
  const h = installation(1)
  await h.flush()
  h.status(false, h.now + 10)
  await h.flush()
  const size = () =>
    Number(h.db.prepare('SELECT COUNT(*) AS count FROM followup_activity').get()?.count)
  const before = size()
  for (let index = 0; index < count; index++) {
    await h.engine.reconcile(['pr0'])
  }
  expect(size()).toBe(before)
  h.stream('pane-w0', true, h.now + 20)
  await h.flush()
  // The older idle recovery sample cannot overwrite more recent stream evidence.
  expect(h.records.workingOverlap('pr0', h.now + 21, h.now + 22)).toBe(true)
  expect(size()).toBe(before + 1)
})

it.each([
  ['chat', 10],
  ['chat', 100],
  ['terminal', 10],
  ['terminal', 100]
] as const)(
  'routes known identities and operations precisely through %s with %i retained PRs on one instance, including restart',
  async (surface, count) => {
    const h = installation(count, false, surface, false, true)
    await h.flush()
    for (const restart of [false, true]) {
      if (restart) {
        await h.restart()
      }
      const histories = new Set<string>()
      let rows = 0
      const prepare = h.db.prepare.bind(h.db)
      const spy = vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
        const statement = prepare(query)
        return new Proxy(statement, {
          get(owner, field) {
            if (field !== 'all' && field !== 'get' && field !== 'run') {
              return Reflect.get(owner, field)
            }
            return (...args: Database.BindValue[]) => {
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
      const reconcile = vi.spyOn(h.engine, 'reconcile')
      const live = vi.mocked(h.inputs.live).mockClear()
      h.stream('unrelated', false, h.now + 5)
      sessionCrewChanges.notify(
        Object.assign(new Set(['records'] as const), {
          recordAuthorities: [{ recordId: 'unrelated', workspaceIds: ['w0'] }]
        })
      )
      await h.flush()
      expect(histories.size).toBe(0)
      expect(rows).toBe(0)
      h.stream('pane-w1', false, h.now + 10)
      await h.flush()
      expect([...histories]).toEqual(['pr1'])
      expect(live).toHaveBeenCalledTimes(1)
      expect(rows).toBeLessThanOrEqual(20)
      histories.clear()
      sessionCrewChanges.notify(
        Object.assign(new Set(['records'] as const), {
          recordAuthorities: [{ operationIds: ['old-pr1'], workspaceIds: ['w0'] }]
        })
      )
      await h.flush()
      expect([...histories]).toEqual(['pr1'])
      expect(live).toHaveBeenCalledTimes(2)
      const jobs = reconcile.mock.calls.filter(([keys]) => keys && [...keys].length)
      expect(jobs).toHaveLength(2)
      expect(jobs.every(([keys]) => [...keys!].join() === 'pr1')).toBe(true)
      spy.mockRestore()
      reconcile.mockRestore()
    }
    const reconcile = vi.spyOn(h.engine, 'reconcile')
    h.status(true, h.now + 20)
    await h.flush()
    expect(reconcile.mock.calls.some(([keys]) => keys && [...keys].includes('pr0'))).toBe(true)
    expect(h.engine.forWorkspace('w0')).not.toBeNull()
  }
)

it.each(['separate', 'shared', 'moved'] as const)(
  'recovers an identity-less obligation on the first mixed committed event with %s workspace authorities',
  async (layout) => {
    const h = installation(2, false, 'chat', false, layout === 'shared')
    await h.flush()
    if (layout === 'shared') {
      h.records.saveAction({
        ...h.records.action('uncertain-pr0')!,
        recoveryFinalizedAt: undefined
      })
      await h.restart()
    }
    if (layout === 'moved') {
      h.inventory(
        h.targets.filter((target) => target.worktreeId !== 'w0'),
        h.workspaces.filter((workspace) => workspace.worktreeId !== 'w0')
      )
      await h.flush()
    }
    const knownWorkspace = layout === 'shared' ? 'w0' : 'w1'
    const recover = vi
      .mocked(recoverFollowUpLaunch)
      .mockImplementation(async (_runtime, action) =>
        action.operationId === 'uncertain-op-pr0'
          ? { status: 'accepted', identity: { surface: 'chat', sessionId: 'late-record' } }
          : { status: 'unconfirmed' }
      )
    recover.mockClear()
    const reconcile = vi.spyOn(h.engine, 'reconcile')
    sessionCrewChanges.notify(
      Object.assign(new Set(['records'] as const), {
        recordAuthorities: [
          { recordId: 'pane-w1', workspaceIds: [knownWorkspace] },
          {
            recordId: 'late-record',
            workspaceIds: layout === 'moved' ? ['w0', 'moved-workspace'] : ['w0']
          }
        ]
      })
    )
    await h.flush()
    expect(recover).toHaveBeenCalledOnce()
    expect(h.records.action('uncertain-pr0')).toMatchObject({
      status: 'accepted',
      sessionId: 'late-record'
    })
    expect(
      reconcile.mock.calls.filter(([keys]) => keys && [...keys].length).map(([keys]) => [...keys!])
    ).toEqual([['pr1', 'pr0']])
    expect(h.engine.prKeysForAuthorities([{ recordId: 'late-record' }])).toEqual(['pr0'])
    expect(launchFollowUp).not.toHaveBeenCalled()
  }
)
