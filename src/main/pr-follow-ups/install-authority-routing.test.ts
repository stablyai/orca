import { expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { installation } from './install-scheduling.test-fixture'
import { recoverFollowUpLaunch } from './launch'
import { sessionCrewChanges } from '../runtime/orchestration/crew/crew-changes'

it.each([
  ['chat', 10],
  ['chat', 100],
  ['terminal', 10],
  ['terminal', 100]
] as const)(
  'routes known records, operations and %s status past %i unrelated unresolved obligations on the same instance',
  async (surface, count) => {
    const h = installation(count + 1, false, surface, false, true)
    await h.flush()
    for (let index = 0; index <= count; index++) {
      if (index !== 1) {
        h.records.saveAction({
          ...h.records.action(`active-pr${index}`)!,
          status: 'unconfirmed',
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
      // Narrow reevaluation must not discard durable pre-acceptance capture on this owner.
      expect(
        h.db
          .prepare('SELECT COUNT(*) AS n FROM followup_activity WHERE identity = ?')
          .get('pane-w1')?.n
      ).toBeGreaterThan(0)
      sql.mockRestore()
      reconcile.mockRestore()
    }
  }
)
