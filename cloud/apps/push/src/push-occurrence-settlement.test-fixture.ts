import { expect } from 'vitest'
import {
  type authorityFixture,
  observePopulationOutcomes,
  required
} from './push-occurrence-authority.test-fixture.js'
import { pushDestination } from './push-occurrence-admission.js'
import { text, ownerCleanup, record } from './push-owner-integration.test-fixture.js'

export function storedNonnegativeInteger(value: unknown): number {
  const decoded =
    typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.exec(value)?.[0] === value
      ? Number(value)
      : value
  if (typeof decoded !== 'number' || !Number.isSafeInteger(decoded) || decoded < 0) {
    throw new Error('Expected stored nonnegative safe integer')
  }
  return decoded
}

export async function drainPopulations(
  f: Awaited<ReturnType<typeof authorityFixture>>,
  label: string,
  holdRoute = false
) {
  const original = new Map(
    (await f.rows('push_delivery_batches')).map((row) => [text(row.batch_id), row])
  )
  const observed = await observePopulationOutcomes(f)
  const workStart = f.work.length
  const txStart = f.activity.transactions.length
  const lockStart = f.activity.advisory.length
  const released = Promise.withResolvers<void>()
  let holder: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let primary: { failed: true; error: unknown } | undefined
  let controlledPark = false
  let phase = 0
  let pass = 0
  try {
    expect(original.size).toBeGreaterThan(0)
    if (holdRoute) {
      expect(f.db.dialect).toBe('postgres')
      const held = Promise.withResolvers<void>()
      const route = `push-routes:${pushDestination(await f.device(f.a.registrationId))}`
      holder = f.db.transaction(async (tx) => {
        await tx.lockScope(route)
        held.resolve()
        await released.promise
      })
      await Promise.race([
        held.promise,
        holder.then(() => {
          throw new Error('Route holder ended before barrier')
        })
      ])
    }
    let residual = [...original.values()]
    const terminal = new Set<string>()
    for (; phase <= original.size; phase++) {
      const completedBefore = terminal.size
      const progressed = new Set<string>()
      for (pass = 0; pass < original.size; pass++) {
        const offset = observed.events.length
        const before = new Set(residual.map((row) => text(row.batch_id)))
        pending = f.server.worker.runDue()
        await pending
        const joined = await observed.join()
        residual = await f.rows('push_delivery_batches')
        const events = observed.events.slice(offset)
        const errors = events.flatMap((event) =>
          event.outcome === 'error'
            ? [event.error]
            : event.diagnostic
              ? [event.diagnostic.error]
              : []
        )
        errors.push(
          ...joined.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason] : [])),
          ...f.work
            .slice(workStart)
            .flatMap((entry) => (entry.outcome === 'error' ? [entry.error] : [])),
          ...f.activity.transactions
            .slice(txStart)
            .flatMap((entry) => [
              ...entry.errors,
              ...(entry.outcome === 'error' ? [entry.error] : [])
            ]),
          ...f.activity.advisory
            .slice(lockStart)
            .flatMap((entry) => (entry.outcome === 'error' ? [entry.error] : []))
        )
        if (errors.length) {
          throw new AggregateError(errors, 'Population method, diagnostic or database failure')
        }
        expect(events.every((event) => event.outcome === 'returned')).toBe(true)
        expect(
          events.filter((event) => event.method === 'finish' && event.input !== undefined)
        ).toEqual([])
        expect(f.work.slice(workStart).every((entry) => entry.outcome === 'returned')).toBe(true)
        expect(
          f.activity.transactions
            .slice(txStart)
            .every((entry) => entry.outcome === 'committed' && entry.errors.length === 0)
        ).toBe(true)
        expect(
          f.activity.advisory.slice(lockStart).every((entry) => entry.outcome === 'returned')
        ).toBe(true)
        const current = new Map(residual.map((row) => [text(row.batch_id), row]))
        let progress = 0
        for (const id of before) {
          if (!current.has(id)) {
            const finish = required(
              events.find((event) => event.method === 'finish' && event.queued.id === id)
            )
            expect(
              f.work
                .slice(workStart)
                .some(
                  (entry) =>
                    entry.sql.startsWith('DELETE FROM push_delivery_batches') &&
                    entry.returning === 1 &&
                    entry.params[0] === id &&
                    entry.params[1] === finish.queued.lease
                )
            ).toBe(true)
            terminal.add(id)
            if (!progressed.has(id)) {
              progressed.add(id)
              progress++
            }
          }
        }
        for (const event of events.filter((entry) => entry.method === 'defer')) {
          const saved = required(required(event.saved)[0])
          expect(event.saved).toHaveLength(1)
          expect(
            events.some(
              (entry) =>
                entry.method === 'acquire' &&
                entry.queued.id === event.queued.id &&
                entry.queued.lease === event.queued.lease &&
                entry.result === 'deferred'
            )
          ).toBe(true)
          expect({
            batch_id: saved.batch_id,
            due_at: storedNonnegativeInteger(saved.due_at),
            lease_token: saved.lease_token,
            lease_until: storedNonnegativeInteger(saved.lease_until),
            attempts: storedNonnegativeInteger(saved.attempts)
          }).toEqual({
            batch_id: event.queued.id,
            due_at: Math.min(event.clock + 1000, event.queued.expiresAt - 1),
            lease_token: null,
            lease_until: 0,
            attempts: event.queued.attempts - 1
          })
          expect(storedNonnegativeInteger(saved.expires_at)).toBe(
            storedNonnegativeInteger(required(original.get(event.queued.id)).expires_at)
          )
          expect(event.completedAt).toBe(event.clock)
          expect(storedNonnegativeInteger(saved.due_at)).toBeGreaterThan(f.clock())
          expect(current.get(event.queued.id)).toEqual(saved)
          if (!progressed.has(event.queued.id)) {
            progressed.add(event.queued.id)
            progress++
          }
        }
        for (const row of residual) {
          expect(original.has(text(row.batch_id))).toBe(true)
          expect(row.state).toBe('pending')
          expect(row.lease_token).toBeNull()
          expect(storedNonnegativeInteger(row.lease_until)).toBe(0)
          expect(storedNonnegativeInteger(row.expires_at)).toBe(
            storedNonnegativeInteger(required(original.get(text(row.batch_id))).expires_at)
          )
          expect(storedNonnegativeInteger(row.expires_at)).toBeGreaterThan(f.clock())
        }
        if (residual.length === 0) {
          expect(holdRoute && !controlledPark).toBe(false)
          expect(terminal.size).toBe(original.size)
          return
        }
        expect(progress).toBeGreaterThan(0)
        if (residual.every((row) => storedNonnegativeInteger(row.due_at) > f.clock())) {
          break
        }
      }
      expect(pass).toBeLessThan(original.size)
      for (const row of residual) {
        expect(
          observed.events.some(
            (event) =>
              event.method === 'defer' &&
              event.outcome === 'returned' &&
              event.queued.id === row.batch_id &&
              event.saved?.some(
                (saved) =>
                  saved.batch_id === row.batch_id &&
                  saved.due_at === row.due_at &&
                  saved.attempts === row.attempts
              )
          )
        ).toBe(true)
      }
      if (holder) {
        expect(
          f.activity.advisory
            .slice(lockStart)
            .some((entry) => entry.key.startsWith('push-routes:') && entry.result === false)
        ).toBe(true)
        expect(observed.events.some((event) => event.method === 'defer')).toBe(true)
        expect(
          f.requests.every(
            (request) => record(record(JSON.parse(request.body)).orca).kind === 'dismiss'
          )
        ).toBe(true)
        released.resolve()
        await holder
        controlledPark = true
        holder = undefined
      } else {
        expect(terminal.size).toBeGreaterThan(completedBefore)
      }
      const wake = Math.min(...residual.map((row) => storedNonnegativeInteger(row.due_at)))
      expect(wake).toBeGreaterThan(f.clock())
      expect(wake).toBeLessThan(
        Math.min(
          ...residual.map((row) =>
            storedNonnegativeInteger(required(original.get(text(row.batch_id))).expires_at)
          )
        )
      )
      f.advance(wake - f.clock())
    }
    throw new Error('Population causal phase budget exhausted')
  } catch (error) {
    const diagnostics = await Promise.allSettled([
      f.rows('push_delivery_batches'),
      f.rows('push_occurrence_domains')
    ])
    primary = {
      failed: true,
      error: new AggregateError(
        [
          error,
          ...diagnostics.flatMap((entry) => (entry.status === 'rejected' ? [entry.reason] : []))
        ],
        JSON.stringify(
          {
            label,
            phase,
            pass,
            clock: f.clock(),
            original: [...original.values()],
            diagnostics,
            events: observed.events,
            work: f.work.slice(workStart),
            transactions: f.activity.transactions.slice(txStart),
            advisory: f.activity.advisory.slice(lockStart),
            provider: f.requests
          },
          (_, value) => (value instanceof Error ? String(value) : value)
        ),
        { cause: error }
      )
    }
  } finally {
    const cleanup = ownerCleanup(primary)
    released.resolve()
    await cleanup.run(() => holder)
    await cleanup.run(() => pending)
    await cleanup.run(async () => {
      const failures = (await observed.join()).flatMap((entry) =>
        entry.status === 'rejected' ? [entry.reason] : []
      )
      if (failures.length) {
        throw new AggregateError(failures, 'Population owned operation cleanup failed')
      }
    })
    await cleanup.run(observed.restore)
    cleanup.finish()
  }
}
