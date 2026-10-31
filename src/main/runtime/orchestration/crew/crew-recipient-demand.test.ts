import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { emptyCrew, type OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { resolveBareOrchestrationRecipient } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  address,
  crewRecord,
  deltaFixture,
  remembered,
  retainedLegacy,
  SELF,
  TARGET
} from './crew-recipient-delta-cost.test-fixture'
import { crewQueryPlans, meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'
import { resolveMessageRun } from '../../rpc/methods/orchestration/routing'
import * as recipientInputs from './crew-recipient-inputs'
import { readCrewOwnedRunAddresses } from './crew-query'
import { createCrewSourceInputs } from './crew-source-inputs'
import { createCrewPartyRegistry } from './crew-parties'

it('does not acquire unconsumed retained legacy facts for native self P0 at L3/30', () => {
  const samples = [3, 30].map((population) => {
    const f = deltaFixture()
    retainedLegacy(f, population)
    const helper = vi.spyOn(f.db, 'getLegacyAdoptedRunMailboxOwner')
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const frames: OrchestrationCrewFrame[] = []
    const stop = subscribeCrew(
      () => model.read(address(SELF)),
      model.subscribe,
      (frame) => frames.push(frame)
    )
    try {
      const output = model.read(address(SELF))
      expect(output).toStrictEqual(emptyCrew('ok'))
      const totals = sqlTotals(meter.executions)
      return {
        population,
        calls: helper.mock.calls.length,
        totals,
        output,
        frames,
        executions: meter.executions
      }
    } finally {
      stop()
      meter.restore()
      helper.mockRestore()
    }
  })
  process.stdout.write(`C2 demand P0 ${JSON.stringify(samples)}\n`)
  expect(samples.map((sample) => sample.calls)).toEqual([0, 0])
})

it('retries complete history after unknown in the same watched generation instead of caching fallback', () => {
  const f = deltaFixture()
  f.records.set(TARGET, crewRecord(TARGET))
  f.visible.add(TARGET)
  f.db.insertMessage({
    from: address(TARGET),
    to: address(SELF),
    subject: 'Peer',
    body: 'retained target'
  })
  remembered(f)
  const runtime = new OrcaRuntimeService()
  // The real command's history refusal precedes fallback, so no provider host is needed.
  const oracle = resolveBareOrchestrationRecipient({ runtime, db: f.db, handle: address(TARGET) })
  expect(oracle).toMatchObject({ ok: false, code: 'recipient_ambiguous' })
  const meter = meterCrewSql(f.db.db)
  const fault = new Error('actual history read failed')
  let failures = 1
  meter.control.before = (sql) => {
    if (sql.includes('coordinator.run_id FROM json_each') && failures-- > 0) {
      throw fault
    }
  }
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const caught: unknown[] = []
  const stop = subscribeCrew(
    () => {
      try {
        return model.read(address(SELF))
      } catch (error) {
        caught.push(error)
        throw error
      }
    },
    model.subscribe,
    (frame) => frames.push(frame)
  )
  try {
    expect(frames).toEqual([{ type: 'begin', status: 'unknown' }, { type: 'complete' }])
    expect(caught).toEqual([fault])
    expect(caught[0]).toBe(fault)
    meter.control.before = undefined
    const output = model.read(address(SELF))
    process.stdout.write(
      `C2 history retry ${JSON.stringify({ output, frames, oracle, executions: meter.executions })}\n`
    )
    expect(output.sections.talkingWith).toHaveLength(1)
    expect(output.sections.talkingWith[0]).not.toHaveProperty('sendAddress')
    expect(
      meter.executions.filter((row) => row.sql.includes('coordinator.run_id FROM json_each'))
    ).toHaveLength(2)
  } finally {
    stop()
    meter.restore()
  }
})

it('retries a consumed legacy error with already complete raw history, preserving the original error', () => {
  const f = deltaFixture()
  f.records.set(TARGET, crewRecord(TARGET))
  f.visible.add(TARGET)
  f.db.insertMessage({
    from: address(TARGET),
    to: address(SELF),
    subject: 'Peer',
    body: 'legacy target'
  })
  retainedLegacy(f, 3, address(TARGET))
  const meter = meterCrewSql(f.db.db)
  const fault = new Error('consumed legacy SQL failed')
  meter.control.before = (sql) => {
    if (sql.includes('FROM legacy_adoptions')) {
      throw fault
    }
  }
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const caught: unknown[] = []
  const stop = subscribeCrew(
    () => {
      try {
        return model.read(address(SELF))
      } catch (error) {
        caught.push(error)
        throw error
      }
    },
    model.subscribe,
    (frame) => frames.push(frame)
  )
  try {
    expect(caught[0]).toBe(fault)
    expect(frames).toEqual([{ type: 'begin', status: 'unknown' }, { type: 'complete' }])
    expect(() => model.read(address(SELF))).toThrow(fault)
    meter.control.before = undefined
    const output = model.read(address(SELF))
    expect(output.sections.talkingWith[0].sendAddress).toBe(address(TARGET))
    expect(
      meter.executions.filter((row) => row.sql.includes('coordinator.run_id FROM json_each'))
    ).toHaveLength(1)
    expect(meter.executions.filter((row) => row.failed)).toHaveLength(2)
    process.stdout.write(
      `C2 legacy failure progress ${JSON.stringify({ output, frames, executions: meter.executions })}\n`
    )
  } finally {
    stop()
    meter.restore()
  }
})

it('shares successful terminal/peer legacy consumers, retries by real writer, and keeps duplicate owner inserts silent', async () => {
  const samples: {
    population: number
    nativeSelf: boolean
    output: ReturnType<CrewReadModel['read']>
    totals: ReturnType<typeof sqlTotals>
    legacyWork: ReturnType<typeof meterCrewSql>['executions'][]
  }[] = []
  for (const population of [3, 30]) {
    for (const nativeSelf of [false, true]) {
      const f = deltaFixture()
      f.records.set(TARGET, crewRecord(TARGET))
      f.visible.add(TARGET)
      const self = nativeSelf ? address(SELF) : 'term_worker'
      retainedLegacy(f, population, nativeSelf ? address(TARGET) : self)
      f.db.insertMessage({ from: address(TARGET), to: self, subject: 'Peer', body: 'legacy peer' })
      const legacyWork: ReturnType<typeof meterCrewSql>['executions'][] = []
      const actualLegacy = f.db.getLegacyAdoptedRunMailboxOwner.bind(f.db)
      const helper = vi.spyOn(f.db, 'getLegacyAdoptedRunMailboxOwner').mockImplementation(() => {
        const start = meter.executions.length
        try {
          return actualLegacy()
        } finally {
          legacyWork.push(meter.executions.slice(start))
        }
      })
      const meter = meterCrewSql(f.db.db)
      const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
      const frames: OrchestrationCrewFrame[] = []
      const stop = subscribeCrew(
        () => model.read(self),
        model.subscribe,
        (frame) => frames.push(frame)
      )
      try {
        const output = model.read(self)
        expect(
          output.sections.talkingWith.find((row) => row.latest?.preview === 'legacy peer')
            ?.sendAddress
        ).toBe(address(TARGET))
        expect(helper).toHaveBeenCalledOnce()
        expect(legacyWork).toHaveLength(1)
        expect(sqlTotals(legacyWork[0])).toMatchObject({ get: 2, all: 3 })
        process.stdout.write(
          `C2 consumed legacy measured ${JSON.stringify({ population, nativeSelf, totals: sqlTotals(meter.executions), legacyTotals: sqlTotals(legacyWork[0]), selectedPlusLegacy: sqlTotals(meter.executions).selected + legacyWork[0].length, executions: meter.executions })}\n`
        )
        expect(sqlTotals(meter.executions).selected + legacyWork[0].length).toBeLessThanOrEqual(10)
        if (population === 3 && nativeSelf) {
          const executions = [...meter.executions]
          meter.control.phase = 'diagnostic'
          process.stdout.write(
            `C2 consumed legacy plans ${JSON.stringify(crewQueryPlans(f.db.db, executions))}\n`
          )
        }
        const before = frames.length
        meter.control.phase = 'writer'
        f.db.rememberRunCoordinatorHandle(f.run.id, 'term_unrelated_new_alias')
        meter.control.phase = 'reacquire'
        await Promise.resolve()
        expect(model.read(self)).toStrictEqual(output)
        expect(helper).toHaveBeenCalledTimes(2)
        expect(frames).toHaveLength(before)
        const count = meter.executions.length
        f.db.rememberRunCoordinatorHandle(f.run.id, 'term_unrelated_new_alias')
        await Promise.resolve()
        expect(meter.executions.slice(count).map((row) => row.method)).toEqual(['run'])
        expect(frames).toHaveLength(before)
        samples.push({
          population,
          nativeSelf,
          output,
          totals: sqlTotals(meter.executions),
          legacyWork
        })
      } finally {
        stop()
        meter.restore()
        helper.mockRestore()
      }
    }
  }
  process.stdout.write(`C2 positive consumers ${JSON.stringify(samples)}\n`)
})

it('preserves absent callback default order, explicit null and late history demand after raw coverage', () => {
  const f = deltaFixture()
  const key = { terminalHandle: 'term_worker', orcaSessionId: null, paneKey: null }
  const memo = createCrewSourceInputs(f.db)
  const helper = vi.spyOn(f.db, 'getLegacyAdoptedRunMailboxOwner')
  const meter = meterCrewSql(f.db.db)
  try {
    readCrewOwnedRunAddresses(f.db, key)
    const history = meter.executions.findIndex((row) => row.sql.includes('coordinator.run_id'))
    const legacy = meter.executions.findIndex((row) => row.sql.includes('FROM legacy_adoptions'))
    expect(history).toBeLessThan(legacy)
    meter.executions.length = 0
    helper.mockClear()
    readCrewOwnedRunAddresses(f.db, key, memo.legacyOwner)
    expect(meter.executions[0].sql).toContain('FROM legacy_adoptions')
    readCrewOwnedRunAddresses(f.db, key, memo.legacyOwner)
    expect(helper).toHaveBeenCalledOnce()
    const fault = new Error('callback before owned history')
    const before = meter.executions.length
    expect(() =>
      readCrewOwnedRunAddresses(f.db, key, () => {
        throw fault
      })
    ).toThrow(fault)
    expect(meter.executions).toHaveLength(before)
    expect(memo.legacyOwner()).toBeNull()
    f.records.set(TARGET, crewRecord(TARGET))
    f.visible.add(TARGET)
    f.db.createRun({
      objective: 'early owner',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: SELF
    })
    const registry = createCrewPartyRegistry(f.deps)
    const lateMemo = createCrewSourceInputs(f.db)
    const facts = recipientInputs.createCrewRecipientInputs(
      f.db,
      registry.records,
      registry.commandCanonical,
      lateMemo.legacyOwner
    )
    facts.prepare([SELF, TARGET])
    helper.mockClear()
    const terminal = { livePane: f.deps.paneForHandle, process: () => null }
    expect(facts.finish([SELF], undefined, terminal)(SELF)).toBe(true)
    expect(helper).not.toHaveBeenCalled()
    const beforeLate = sqlTotals(meter.executions).selected
    expect(facts.finish([TARGET], undefined, terminal)(TARGET)).toBe(true)
    expect(helper).toHaveBeenCalledOnce()
    expect(sqlTotals(meter.executions).selected).toBe(beforeLate)
    expect(lateMemo.legacyOwner()).toBeNull()
    expect(helper).toHaveBeenCalledOnce()
  } finally {
    helper.mockRestore()
    meter.restore()
  }
})

it('keeps global legacy unconsumed for early owners, active ambiguity and refused callers', () => {
  const samples = [3, 30].flatMap((population) =>
    ['current', 'dispatch', 'ambiguity', 'refused'].map((kind) => {
      const f = deltaFixture()
      f.records.set(TARGET, crewRecord(TARGET))
      f.visible.add(TARGET)
      f.db.insertMessage({
        from: address(TARGET),
        to: address(SELF),
        subject: 'Peer',
        body: 'same body'
      })
      retainedLegacy(f, population)
      const dispatch = (handle: string) =>
        f.db.createDispatchContext({
          taskId: f.db.createTask({ runId: f.run.id, spec: kind }).id,
          assigneeHandle: handle,
          creator: { kind: 'system' },
          maxDepth: 10
        })
      if (kind === 'current') {
        f.db.createRun({
          objective: kind,
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorOrcaSessionId: TARGET
        })
      } else if (kind === 'refused') {
        const row = dispatch(address(SELF))
        f.db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(row.run_id)
      } else {
        dispatch(address(TARGET))
        if (kind === 'ambiguity') {
          const second = dispatch('term_retained_duplicate')
          // Retained duplicate-owner control; the ordinary producer refuses occupied handles.
          f.db.db
            .prepare(
              'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_orca_session_id = ? WHERE id = ?'
            )
            .run(address(TARGET), TARGET, second.id)
        }
      }
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(f.db)
      if (kind === 'refused') {
        expect(() =>
          resolveMessageRun(runtime, {
            sender: {
              address: address(SELF),
              terminalHandle: null,
              paneKey: null,
              orcaSessionId: SELF
            },
            to: address(TARGET)
          })
        ).toThrow('was not found')
      } else {
        expect(
          resolveBareOrchestrationRecipient({ runtime, db: f.db, handle: address(TARGET) }).ok
        ).toBe(kind !== 'ambiguity')
      }
      const helper = vi.spyOn(f.db, 'getLegacyAdoptedRunMailboxOwner')
      const meter = meterCrewSql(f.db.db)
      const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
      const stop = model.subscribe(() => {})
      try {
        const output = model.read(address(SELF))
        const row = output.sections.talkingWith.find(
          (candidate) => candidate.latest?.preview === 'same body'
        )!
        expect(row).toBeDefined()
        expect(row.latest?.preview).toBe('same body')
        return {
          population,
          kind,
          calls: helper.mock.calls.length,
          output,
          totals: sqlTotals(meter.executions)
        }
      } finally {
        stop()
        meter.restore()
        helper.mockRestore()
      }
    })
  )
  process.stdout.write(`C2 early nonconsumers ${JSON.stringify(samples)}\n`)
  for (const sample of samples) {
    expect(
      Boolean(
        sample.output.sections.talkingWith.find((row) => row.latest?.preview === 'same body')
          ?.sendAddress
      )
    ).toBe(sample.kind === 'current' || sample.kind === 'dispatch')
  }
  expect(samples.map((sample) => sample.calls)).toEqual(samples.map(() => 0))
})

it('does not demand legacy during late caller-only preparation of the actual retained adapter', () => {
  const f = deltaFixture(1)
  const peer = testOrcaSessionId('chat-delta-0')
  f.db.createRun({
    objective: 'earlier peer owner',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: peer
  })
  retainedLegacy(f, 3)
  let captured: ReturnType<typeof recipientInputs.createCrewRecipientInputs> | undefined
  const original = recipientInputs.createCrewRecipientInputs
  const capture = vi
    .spyOn(recipientInputs, 'createCrewRecipientInputs')
    .mockImplementation((...args) => {
      captured = original(...args)
      return captured
    })
  const helper = vi.spyOn(f.db, 'getLegacyAdoptedRunMailboxOwner')
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  const stop = model.subscribe(() => {})
  try {
    expect(model.read(address(SELF)).sections.talkingWith[0].sendAddress).toBe(
      `orca_session_id:${peer}`
    )
    expect(captured).toBeDefined()
    captured!.prepare([], {
      address: 'term_late',
      terminalHandle: 'term_late',
      paneKey: null,
      orcaSessionId: null
    })
    expect(helper).not.toHaveBeenCalled()
  } finally {
    stop()
    helper.mockRestore()
    capture.mockRestore()
  }
})

it('keeps failed or malformed explicit acquisition unknown and retries complete facts without losing working explicit actions', async () => {
  for (const failure of ['read', 'parse'] as const) {
    const f = deltaFixture()
    const worker = f.assign('term_worker')
    const fault = new Error('explicit SQL source failed')
    let injections = 0
    const explicitRequest = (sql: string, value: unknown) =>
      sql.includes("'explicit'") && typeof value === 'string' && value.includes('"id":')
    const meter = meterCrewSql(f.db.db)
    meter.control.before = (sql) => {
      if (
        failure === 'read' &&
        injections === 0 &&
        explicitRequest(sql, meter.executions.at(-1)?.parameters[0])
      ) {
        injections++
        throw fault
      }
    }
    if (failure === 'parse') {
      const prepare = vi.mocked(f.db.db.prepare).getMockImplementation()
      if (!prepare) {
        throw new Error('SQL meter implementation missing')
      }
      vi.mocked(f.db.db.prepare).mockImplementation((sql) => {
        const statement = prepare(sql)
        return {
          all: (...params) => {
            const rows = statement.all(...params)
            if (injections === 0 && explicitRequest(sql, params[0])) {
              injections++
              return rows.map((row) => ({ ...row, status: 9 }))
            }
            return rows
          },
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
          iterate: (...params) => statement.iterate(...params),
          setReadBigInts: (value) => statement.setReadBigInts(value)
        }
      })
    }
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const frames: OrchestrationCrewFrame[] = []
    const caught: unknown[] = []
    const stop = subscribeCrew(
      () => {
        try {
          return model.read('term_coord')
        } catch (error) {
          caught.push(error)
          throw error
        }
      },
      model.subscribe,
      (frame) => frames.push(frame)
    )
    try {
      expect(frames).toEqual([{ type: 'begin', status: 'unknown' }, { type: 'complete' }])
      expect(caught).toHaveLength(1)
      if (failure === 'read') {
        expect(caught[0]).toBe(fault)
      } else {
        expect(caught[0]).toMatchObject({
          name: 'ZodError',
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'invalid_type', path: [0, 'status'] })
          ])
        })
      }
      expect(injections).toBe(1)
      const before = meter.executions.length
      meter.control.phase = 'retry'
      f.db.crewChanges.notify(new Set(['names']))
      await Promise.resolve()
      expect(
        frames
          .filter((frame) => frame.type === 'rows')
          .flatMap((frame) => (frame.type === 'rows' ? frame.rows : []))
      ).toEqual([expect.objectContaining({ sendAddress: `dispatch:${worker.id}` })])
      expect(frames.filter((frame) => frame.type === 'begin')).toEqual([
        { type: 'begin', status: 'unknown' },
        { type: 'begin', status: 'ok' }
      ])
      const complete = model.read('term_coord')
      expect(complete.sections.managing).toHaveLength(1)
      expect(complete.sections.managing[0].sendAddress).toBe(`dispatch:${worker.id}`)
      expect(
        meter.executions
          .slice(before)
          .some(
            (entry) =>
              entry.sql.includes("'explicit'") &&
              typeof entry.parameters[0] === 'string' &&
              entry.parameters[0].includes('"id":')
          )
      ).toBe(true)
      const equal = frames.length
      f.db.crewChanges.notify(new Set(['names']))
      await Promise.resolve()
      expect(frames).toHaveLength(equal)
      stop()
      const reacquired = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
      expect(reacquired.read('term_coord')).toEqual(complete)
      expect(injections).toBe(1)
      process.stdout.write(
        `C2 explicit fault reach ${JSON.stringify({ failure, injections, frames, exactReadError: failure === 'read' ? caught[0] === fault : undefined, executions: meter.executions })}\n`
      )
    } finally {
      stop()
      meter.restore()
    }
  }
})
