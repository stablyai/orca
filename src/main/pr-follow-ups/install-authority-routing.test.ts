import { expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { installation } from './install-scheduling.test-fixture'
import { recoverFollowUpLaunch } from './launch'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'

const knownCases = (['accepted', 'unresolved'] as const).flatMap((population) =>
  (['chat', 'terminal'] as const).flatMap((surface) =>
    [10, 100].map((count) => ({ population, surface, count }))
  )
)

it.each(knownCases)(
  'routes records, operations and $surface status past $count unrelated $population obligations',
  async ({ surface, count, population }) => {
    const h = installation(count + 1, false, surface, false, true)
    await h.flush()
    for (let index = 0; index <= count; index++) {
      if (population === 'unresolved' && index !== 1) {
        h.records.saveAction({
          ...h.records.action(`active-pr${index}`)!,
          status: 'unconfirmed',
          instanceId: `unresolved-owner-${index}`,
          sessionId: undefined,
          paneKey: undefined,
          sessionStartedAt: undefined
        })
      }
    }
    // Reconstruct admission routing from persisted claims before attaching stream listeners.
    await h.restart()
    for (const restart of [false, true]) {
      if (restart) {
        await h.restart()
      }
      const histories = new Set<string>()
      let rows = 0
      const prepare = h.db.prepare.bind(h.db)
      const sql = vi.spyOn(h.db, 'prepare').mockImplementation((query) => {
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
      const recover = vi.mocked(recoverFollowUpLaunch).mockClear()
      const live = vi.mocked(h.inputs.live).mockClear()
      // An unrelated event has no recipients when every retained action is already known.
      if (population === 'accepted') {
        h.stream('unrelated', false, h.now + 5)
        sessionCrewChanges.notify(
          Object.assign(new Set(['records'] as const), {
            recordAuthorities: [{ recordId: 'unrelated', workspaceIds: ['w0'] }]
          })
        )
        await h.flush()
        expect(histories.size).toBe(0)
        expect(rows).toBe(0)
      }
      const triggers = [
        () =>
          sessionCrewChanges.notify(
            Object.assign(new Set(['records'] as const), {
              recordAuthorities: [{ recordId: 'pane-w1', workspaceIds: ['w0'] }]
            })
          ),
        () =>
          sessionCrewChanges.notify(
            Object.assign(new Set(['records'] as const), {
              recordAuthorities: [{ operationIds: ['old-pr1'], workspaceIds: ['w0'] }]
            })
          ),
        () =>
          sessionCrewChanges.notify(
            Object.assign(new Set(['records'] as const), {
              recordAuthorities: [
                { recordId: 'not-attached', operationIds: ['old-pr1'], workspaceIds: ['w0'] }
              ]
            })
          ),
        () => h.stream('pane-w1', false, h.now + 10)
      ]
      for (const trigger of triggers) {
        histories.clear()
        rows = 0
        reconcile.mockClear()
        live.mockClear()
        trigger()
        await h.flush()
        expect([...histories]).toEqual(['pr1'])
        expect(recover).not.toHaveBeenCalled()
        expect(live).toHaveBeenCalledOnce()
        expect(rows).toBeLessThanOrEqual(20)
        expect(
          reconcile.mock.calls.filter(([keys]) => keys && [...keys].length).map(([keys]) => keys)
        ).toEqual([['pr1']])
      }
      // Every unresolved owner captures evidence even though only pr1 is reevaluated.
      expect(
        h.db
          .prepare(
            'SELECT DISTINCT instance_id FROM followup_activity WHERE identity = ? AND at = ? ORDER BY instance_id'
          )
          .all('pane-w1', h.now + 10)
          .map((row) => row.instance_id)
          .sort()
      ).toEqual(
        (population === 'unresolved'
          ? [
              'i0',
              ...Array.from(
                { length: count + 1 },
                (_, index) => `unresolved-owner-${index}`
              ).filter((id) => id !== 'unresolved-owner-1')
            ]
          : ['i0']
        ).sort()
      )
      sql.mockRestore()
      reconcile.mockRestore()
    }
    if (population === 'accepted') {
      const reconcile = vi.spyOn(h.engine, 'reconcile')
      h.status(true, h.now + 20)
      await h.flush()
      expect(reconcile.mock.calls.some(([keys]) => keys && [...keys].includes('pr0'))).toBe(true)
      expect(h.engine.forWorkspace('w0')).not.toBeNull()
    }
  }
)
