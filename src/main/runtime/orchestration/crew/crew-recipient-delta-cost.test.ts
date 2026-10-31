import { z } from 'zod'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import {
  address,
  crewRecord,
  deltaFixture,
  remembered,
  SELF,
  TARGET
} from './crew-recipient-delta-cost.test-fixture'
import {
  crewQueryPlans,
  meterCrewSql,
  selectedKeyMultiplier,
  sqlTotals
} from './crew-recipient-sql.test-fixture'
import * as recipientInputs from './crew-recipient-inputs'
import * as lineage from '../structured-session-lineage'
import * as canonical from '../canonical-orca-session-id'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { resolveBareOrchestrationRecipient } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { resolveMessageRun } from '../../rpc/methods/orchestration/routing'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities
} from '../../structured-worker-identity'
import * as ownerSelection from '../../rpc/methods/orchestration/messaging/recipient-routing'
import { OrcaRuntimeService } from '../../orca-runtime'

it('charges independent peers on the whole trigger, covered reuse and equal topology reacquisition', () => {
  const samples = [3, 30].map((population) => {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    for (let i = 0; i < population; i++) {
      const id = testOrcaSessionId(`chat-authority-${i}`)
      f.records.set(id, crewRecord(id))
      f.visible.add(id)
      f.db.insertMessage({
        id: `unknown-${i}`,
        from: address(id),
        to: 'term_worker',
        subject: 'Peer',
        body: `peer ${i}`
      })
    }
    const sourceRows = vi.spyOn(f.deps.records!, 'listRecords')
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read('term_worker')
      expect(output.sections.talkingWith).toHaveLength(population)
      expect(
        output.sections.talkingWith.every((row) => row.sendAddress && row.latest && row.openTarget)
      ).toBe(true)
      expect(sourceRows).toHaveBeenCalledOnce()
      const cold = sqlTotals(meter.executions)
      expect(cold.selected).toBe(4)
      expect(cold.keys).toBeLessThanOrEqual(10 * population + 10)
      expect(
        meter.executions.filter(
          (entry) => selectedKeyMultiplier(entry.sql) || entry.sql.includes('FROM legacy_adoptions')
        ).length
      ).toBeLessThanOrEqual(10)
      expect(model.read('term_worker')).toStrictEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(cold.selected)
      expect(sourceRows).toHaveBeenCalledOnce()
      f.db.crewChanges.notify(new Set(['topology']))
      expect(model.read('term_worker')).toEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(2 * cold.selected)
      expect(sourceRows).toHaveBeenCalledTimes(2)
      return {
        population,
        cold,
        storedRows: f.records.size,
        storedChars: JSON.stringify([...f.records.values()]).length,
        outputChars: JSON.stringify(output).length,
        output,
        executions: meter.executions
      }
    } finally {
      stop()
      meter.restore()
      sourceRows.mockRestore()
    }
  })
  for (const field of ['all', 'get', 'rows', 'bytes', 'keys', 'requestChars'] as const) {
    expect(samples[1].cold[field]).toBeLessThanOrEqual(10 * samples[0].cold[field] + 100)
  }
  process.stdout.write(`C2 P whole trigger ${JSON.stringify(samples)}\n`)
})

it('charges independent current, Dispatch, history, seat, resource and key-character populations', () => {
  const samples: {
    axis: 'current' | 'dispatch' | 'history' | 'seat' | 'resource' | 'characters'
    n: number
    historySelections: { length: number; chars: number }[]
    dispatchSelections: number[]
    historySetInput: number
    historyUnique: number
    historySortCardinality: number
    candidateRows: number
    seatCandidates: number
    resourceCandidates: number
    total: ReturnType<typeof sqlTotals>
    whole: ReturnType<typeof sqlTotals>
    output: ReturnType<CrewReadModel['read']>
    oracle: ReturnType<typeof resolveBareOrchestrationRecipient>
    executions: ReturnType<typeof meterCrewSql>['executions']
  }[] = []
  for (const axis of [
    'current',
    'dispatch',
    'history',
    'seat',
    'resource',
    'characters'
  ] as const) {
    for (const n of [3, 30]) {
      const f = deltaFixture()
      f.records.set(TARGET, crewRecord(TARGET))
      f.visible.add(TARGET)
      f.db.insertMessage({
        from: address(TARGET),
        to: address(SELF),
        subject: 'Peer',
        body: 'density peer'
      })
      const pane = mintStructuredWorkerPaneKey(TARGET)
      const dispatch = (handle: string) =>
        f.db.createDispatchContext({
          taskId: f.db.createTask({ runId: f.run.id, spec: 'density' }).id,
          assigneeHandle: handle,
          creator: { kind: 'system' },
          maxDepth: 10
        })
      let candidateRows = 0
      if (axis === 'current') {
        const runs = remembered(f, TARGET, n)
        // Retained duplicate current bindings; ordinary createRun unbinds the preceding owner.
        for (const run of runs) {
          f.db.db
            .prepare(
              'UPDATE runs SET coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation WHERE id = ?'
            )
            .run(TARGET, run.id)
        }
        candidateRows = n
      } else if (axis === 'history' || axis === 'seat') {
        const runs = remembered(f, TARGET, axis === 'history' ? n : 1)
        if (axis === 'seat') {
          for (let i = 0; i < n; i++) {
            const row = f.db.createDispatchContext({
              taskId: f.db.createTask({ runId: runs[0].id, spec: 'seat exclusion' }).id,
              assigneeHandle: `term_seat_${i}`,
              creator: { kind: 'system' },
              maxDepth: 10
            })
            // Retained settled candidates; completed before first bind, so history remains legitimate.
            f.db.db
              .prepare(
                "UPDATE dispatch_contexts SET assignee_handle = ?, status = 'completed', created_at = '2000-01-01', completed_at = '2000-01-02' WHERE id = ?"
              )
              .run(address(TARGET), row.id)
          }
        }
        candidateRows = axis === 'history' ? n : 1
      } else if (axis === 'dispatch') {
        for (let i = 0; i < n; i++) {
          const row = dispatch(`term_duplicate_${i}`)
          // Retained same-session exact-handle candidates; all matching owners remain complete.
          f.db.db
            .prepare(
              'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_orca_session_id = ?, assignee_pane_key = ? WHERE id = ?'
            )
            .run(address(TARGET), TARGET, pane, row.id)
        }
        candidateRows = n
      } else {
        const handle = `structworker_${'x'.repeat(axis === 'characters' ? n * 5 : 16)}`
        const count = axis === 'resource' ? n : 1
        for (let i = 0; i < count; i++) {
          const row = dispatch(`term_resource_${i}`)
          f.db.db
            .prepare(
              "UPDATE dispatch_contexts SET status = 'completed', completed_at = '2000-01-01' WHERE id = ?"
            )
            .run(row.id)
          const resource = f.db.createWorkerTerminalResourceStatement({
            dispatchId: row.id,
            worktreeId: 'workspace-1',
            terminalHandle: handle,
            paneKey: pane,
            processIncarnation: `structured:${TARGET}`,
            ownership: 'owned',
            hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
          })
          if (i === count - 1) {
            f.db.db
              .prepare(
                "UPDATE dispatch_contexts SET status = 'pending', completed_at = NULL, assignee_handle = ?, assignee_orca_session_id = ?, assignee_pane_key = ?, process_incarnation = ? WHERE id = ?"
              )
              .run(handle, TARGET, pane, `structured:${TARGET}`, row.id)
          }
          f.db.db
            .prepare('UPDATE worker_terminal_resources SET updated_at = ? WHERE id = ?')
            .run(`2099-01-${String(i + 1).padStart(2, '0')}`, resource.id)
        }
        candidateRows = count
      }
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(f.db)
      const store = vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(f.deps.records)
      const oracle = resolveBareOrchestrationRecipient({
        runtime,
        db: f.db,
        handle: address(TARGET)
      })
      store.mockRestore()
      const historySelections: { length: number; chars: number }[] = []
      const dispatchSelections: number[] = []
      const actualSelect = ownerSelection.selectBareRecipientOwner
      const select = vi
        .spyOn(ownerSelection, 'selectBareRecipientOwner')
        .mockImplementation((input) =>
          actualSelect({
            ...input,
            dispatches: () => {
              const rows = input.dispatches()
              dispatchSelections.push(rows.length)
              return rows
            },
            ownerRunIds: () => {
              const ids = input.ownerRunIds()
              historySelections.push({ length: ids.length, chars: JSON.stringify(ids).length })
              return ids
            }
          })
        )
      const meter = meterCrewSql(f.db.db)
      const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
      const stop = model.subscribe(() => {})
      try {
        const output = model.read(address(SELF))
        const row = Object.values(output.sections)
          .flat()
          .find((value) => value.latest?.preview === 'density peer')!
        expect(row).toBeDefined()
        expect(row.latest?.preview).toBe('density peer')
        expect(row.openTarget).toBeDefined()
        expect(Boolean(row.sendAddress)).toBe(oracle.ok)
        const selected = meter.executions.filter((entry) => selectedKeyMultiplier(entry.sql))
        const total = sqlTotals(selected)
        expect(selected.length).toBeLessThanOrEqual(5)
        expect(total.keys).toBeLessThanOrEqual(10 + 7)
        const relevant = selected.find((entry) =>
          axis === 'current'
            ? entry.sql.includes('SELECT * FROM candidates')
            : axis === 'dispatch'
              ? entry.sql.includes("'handle' AS branch")
              : entry.sql.includes('coordinator.run_id FROM json_each')
        )
        if (axis === 'current' || axis === 'history' || axis === 'seat') {
          expect(relevant?.rows).toBe(candidateRows)
        }
        if (axis === 'dispatch') {
          expect(relevant?.rows).toBe(n)
        }
        if (axis === 'resource' || axis === 'characters') {
          expect(selected).toHaveLength(5)
          expect(selected.find((entry) => entry.sql.includes("'handle' AS branch"))?.rows).toBe(3)
        }
        const historyRows = selected
          .filter((entry) => entry.sql.includes('coordinator.run_id FROM json_each'))
          .flatMap((entry) => entry.results)
        const historyIds = historyRows.flatMap((row) =>
          typeof row.run_id === 'string' ? [row.run_id] : []
        )
        const historyUnique = new Set(historyIds).size
        expect(historyUnique).toBeLessThanOrEqual(historyIds.length)
        samples.push({
          axis,
          n,
          historySelections,
          dispatchSelections,
          historySetInput: historyIds.length,
          historyUnique,
          historySortCardinality: axis === 'history' || axis === 'seat' ? historyUnique : 0,
          candidateRows,
          seatCandidates: axis === 'seat' ? n : 0,
          resourceCandidates: axis === 'resource' ? n : Number(axis === 'characters'),
          total,
          whole: sqlTotals(meter.executions),
          output,
          oracle,
          executions: meter.executions
        })
        if ((axis === 'resource' || axis === 'dispatch') && n === 3) {
          meter.control.phase = 'diagnostic'
          process.stdout.write(
            `C2 actual SQL plans ${JSON.stringify({ axis, n, ...crewQueryPlans(f.db.db, selected) })}\n`
          )
        }
      } finally {
        stop()
        meter.restore()
        select.mockRestore()
        const identity = structuredWorkerIdentities.getBySessionId(TARGET)
        if (identity) {
          structuredWorkerIdentities.forget(identity.handle)
        }
      }
    }
  }
  process.stdout.write(`C2 independent density ${JSON.stringify(samples)}\n`)
})

it('charges Q actual caller keys independently of P over one fixed thirty-caller corpus', () => {
  const samples = [3, 30].map((q) => {
    const f = deltaFixture(3)
    const callers = Array.from({ length: 30 }, (_, i) => testOrcaSessionId(`chat-caller-${i}`))
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(f.db)
    const commandRuns = new Map<string, string | undefined>()
    for (const caller of callers) {
      f.records.set(caller, crewRecord(caller))
      f.visible.add(caller)
      for (let i = 0; i < 3; i++) {
        const row = f.db.createDispatchContext({
          taskId: f.db.createTask({ runId: f.run.id, spec: 'retained caller candidates' }).id,
          assigneeHandle: `term_caller_${caller}_${i}`,
          creator: { kind: 'system' },
          maxDepth: 10
        })
        // Retained coherent duplicate caller candidates; command chooses newest raw match.
        f.db.db
          .prepare(
            'UPDATE dispatch_contexts SET assignee_handle = ?, assignee_orca_session_id = ? WHERE id = ?'
          )
          .run(address(caller), caller, row.id)
      }
      commandRuns.set(
        caller,
        resolveMessageRun(runtime, {
          sender: {
            address: address(caller),
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: caller
          },
          to: address(TARGET)
        }).run?.id
      )
    }
    let facts: ReturnType<typeof recipientInputs.createCrewRecipientInputs> | undefined
    const actual = recipientInputs.createCrewRecipientInputs
    const capture = vi
      .spyOn(recipientInputs, 'createCrewRecipientInputs')
      .mockImplementation((...args) => {
        facts = actual(...args)
        return facts
      })
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read(address(SELF))
      expect(output.sections.talkingWith).toHaveLength(3)
      expect(facts).toBeDefined()
      const initial = meter.executions.length
      for (const id of callers.slice(0, q)) {
        const start = meter.executions.length
        const caller = facts!.prepare([], {
          address: address(id),
          orcaSessionId: id,
          terminalHandle: null,
          paneKey: null
        })
        expect(facts!.senderRun(caller)).toStrictEqual({ kind: 'ready', id: commandRuns.get(id) })
        const attempt = sqlTotals(meter.executions.slice(start))
        expect(attempt.selected).toBeLessThanOrEqual(5)
        expect(attempt.keys).toBe(7)
        expect(
          meter.executions.slice(start).find((entry) => entry.sql.includes("'handle' AS branch"))
            ?.rows
        ).toBe(3)
      }
      expect(model.read(address(SELF))).toStrictEqual(output)
      return {
        q,
        p: 3,
        storedRecords: f.records.size,
        total: sqlTotals(meter.executions.slice(initial)),
        output,
        executions: meter.executions.slice(initial)
      }
    } finally {
      stop()
      meter.restore()
      capture.mockRestore()
    }
  })
  expect(samples[1].total.keys).toBe(10 * samples[0].total.keys)
  expect(samples[1].total.selected).toBe(10 * samples[0].total.selected)
  process.stdout.write(`C2 caller Q ${JSON.stringify(samples)}\n`)
})

it('charges actual repeated reverse visits, per-resolver forward discovery and every complete lineage output', () => {
  const samples = [3, 30].map((n) => {
    const f = deltaFixture()
    const ids = Array.from({ length: n }, (_, i) => testOrcaSessionId(`chat-clear-${i}`))
    for (const [i, id] of ids.entries()) {
      const record = crewRecord(id)
      f.records.set(
        id,
        i + 1 < ids.length
          ? {
              ...record,
              conversationCommand: {
                command: 'clear',
                state: 'completed',
                phase: 'committed',
                callerKey: 'clear',
                operationId: `op-${i}`,
                replacementSessionId: ids[i + 1]
              }
            }
          : record
      )
      f.visible.add(id)
    }
    f.db.insertMessage({
      from: address(ids[n - 1]),
      to: address(SELF),
      subject: 'clear',
      body: 'complete lineage'
    })
    let reverseVisits = 0,
      reverseChars = 0,
      discoveries = 0,
      outputNodes = 0,
      outputChars = 0,
      resolvers = 0
    const actualCanonical = canonical.canonicalOrcaSessionFromEdges
    const reverse = vi
      .spyOn(canonical, 'canonicalOrcaSessionFromEdges')
      .mockImplementation((id, edges) => {
        const checked: ReadonlyMap<string, string> = {
          size: edges.size,
          get: (key) => {
            reverseVisits++
            reverseChars += key.length
            return edges.get(key)
          },
          has: (key) => edges.has(key),
          entries: () => edges.entries(),
          keys: () => edges.keys(),
          values: () => edges.values(),
          forEach: (callback, thisArg) =>
            edges.forEach((value, key) => callback.call(thisArg, value, key, checked)),
          [Symbol.iterator]: () => edges[Symbol.iterator]()
        }
        return actualCanonical(id, checked)
      })
    const actualFactory = lineage.createLineageRunningSessionResolver
    const forward = vi
      .spyOn(lineage, 'createLineageRunningSessionResolver')
      .mockImplementation((reader) => {
        resolvers++
        const resolve = actualFactory(
          reader && {
            ...reader,
            getRecord: (id) => {
              discoveries++
              return reader.getRecord(id)
            }
          }
        )
        return (id) => {
          const value = resolve(id)
          outputNodes += value.lineage.length
          outputChars += JSON.stringify(value.lineage).length
          return value
        }
      })
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read(address(SELF))
      expect(output.sections.talkingWith[0].sendAddress).toBe(address(ids[0]))
      expect(resolvers).toBeGreaterThan(0)
      expect(discoveries).toBeLessThanOrEqual(resolvers * (n + 1))
      expect(outputNodes).toBeGreaterThanOrEqual(n)
      const before = {
        reverseVisits,
        discoveries,
        outputNodes,
        sql: sqlTotals(meter.executions).selected
      }
      expect(model.read(address(SELF))).toStrictEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(before.sql)
      expect(reverseVisits).toBeGreaterThan(before.reverseVisits)
      expect(outputNodes).toBe(2 * before.outputNodes)
      expect(discoveries).toBeLessThanOrEqual(resolvers * (n + 1))
      return {
        n,
        reverseVisits,
        reverseChars,
        discoveries,
        outputNodes,
        outputChars,
        resolvers,
        output,
        total: sqlTotals(meter.executions)
      }
    } finally {
      stop()
      meter.restore()
      reverse.mockRestore()
      forward.mockRestore()
    }
  })
  process.stdout.write(`C2 complete lineage ${JSON.stringify(samples)}\n`)
})

it('charges the full pending provenance/all-row authority trigger at N/10N, including actual rows/chars and downstream selections', () => {
  const samples = [3, 30].map((population) => {
    const f = deltaFixture()
    f.records.clear()
    f.visible.clear()
    const pendingIds: string[] = []
    const trafficIds: string[] = []
    const add = (handle: string, i: number) =>
      f.handles.set(handle, `tab_${handle}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`)
    let now = 0
    for (let i = 0; i < population; i++) {
      const parentHandle = `term_parent_${i}`
      const askerHandle = `term_asker_${i}`
      const managedHandle = `term_managed_${i}`
      const peerHandle = `term_recent_${i}`
      for (const [offset, handle] of [
        parentHandle,
        askerHandle,
        managedHandle,
        peerHandle
      ].entries()) {
        add(handle, 4 * i + offset)
      }
      const parent = f.assign(parentHandle)
      const asker = f.assign(askerHandle, parentHandle)
      f.assign(managedHandle)
      const question = f.db.createQuestion({
        runId: f.run.id,
        dispatchId: asker.id,
        askerHandle,
        question: `aged question ${i}`
      })
      now = Date.parse(question.message.created_at) + 30 * 60 * 1000 + 1
      pendingIds.push(asker.id)
      f.db.completeDispatch(parent.id)
      f.db.db
        .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', parent.id)
      const recent = f.db.insertMessage({
        from: peerHandle,
        to: 'term_coord',
        subject: 'ordinary terminal',
        body: `recent ${i}`
      })
      trafficIds.push(recent.id)
    }
    for (const id of trafficIds) {
      f.db.db
        .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
        .run(new Date(now).toISOString(), id)
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const selection = vi.spyOn(ownerSelection, 'selectBareRecipientOwner')
    const names = vi.fn(f.deps.name)
    f.deps.name = names
    const livePane = vi.fn(f.deps.livePaneForHandle!)
    const process = vi.fn(f.deps.processForHandle!)
    f.deps.livePaneForHandle = livePane
    f.deps.processForHandle = process
    const meter = meterCrewSql(f.db.db)
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read('term_coord')
      expect(output.sections.managing).toHaveLength(population)
      expect(output.sections.talkingWith).toHaveLength(2 * population)
      expect(
        output.sections.talkingWith.filter((row) => row.pendingQuestion && !row.latest)
      ).toHaveLength(population)
      expect(
        output.sections.talkingWith.filter((row) => row.latest && !row.pendingQuestion)
      ).toHaveLength(population)
      expect(
        Object.values(output.sections)
          .flat()
          .every((row) => row.sendAddress && row.openTarget)
      ).toBe(true)
      const provenance = meter.executions.filter(
        (entry) =>
          entry.sql.includes('WHERE d.rowid IN') &&
          typeof entry.parameters[4] === 'string' &&
          pendingIds.every((id) => String(entry.parameters[4]).includes(id))
      )
      expect(provenance).toHaveLength(1)
      const raw = meter.executions.slice()
      const totals = sqlTotals(raw)
      const keyWork = {
        identity: 0,
        currentSession: 0,
        currentPane: 0,
        namedRun: 0,
        activeHandle: 0,
        activePane: 0,
        activeSuffix: 0,
        explicitDispatch: 0,
        history: 0
      }
      for (const entry of raw) {
        if (!selectedKeyMultiplier(entry.sql) || typeof entry.parameters[0] !== 'string') {
          continue
        }
        const requests = z
          .array(z.record(z.string(), z.unknown()))
          .parse(JSON.parse(entry.parameters[0]))
        for (const request of requests) {
          if (entry.sql.includes('AS recorded')) {
            keyWork.identity += 2
          } else if (entry.sql.includes("'handle' AS branch")) {
            if (typeof request.id === 'string') {
              keyWork.explicitDispatch++
            } else {
              keyWork.activeHandle++
              if (typeof request.pane === 'string') {
                keyWork.activePane++
              }
              if (typeof request.suffix === 'string') {
                keyWork.activeSuffix++
              }
            }
          } else if (entry.sql.includes('coordinator.run_id FROM json_each')) {
            keyWork.history++
          } else {
            if (typeof request.id === 'string') {
              keyWork.namedRun++
            }
            if (typeof request.session === 'string') {
              keyWork.currentSession++
            }
            if (typeof request.suffix === 'string') {
              keyWork.currentPane++
            }
          }
        }
      }
      const boundChars = raw.reduce(
        (sum, entry) =>
          sum +
          entry.parameters.reduce<number>(
            (chars, value) => chars + (typeof value === 'string' ? value.length : 0),
            0
          ),
        0
      )
      const work = {
        selectors: selection.mock.calls.length,
        livePane: livePane.mock.calls.length,
        process: process.mock.calls.length,
        names: names.mock.calls.length
      }
      expect(work.selectors).toBe(2 * population)
      expect(model.read('term_coord')).toEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(totals.selected)
      f.db.crewChanges.notify(new Set(['topology']))
      expect(model.read('term_coord')).toEqual(output)
      expect(sqlTotals(meter.executions).selected).toBe(2 * totals.selected)
      return {
        population,
        totals,
        keyWork,
        boundChars,
        work,
        outputChars: JSON.stringify(output).length,
        output,
        raw,
        plans: crewQueryPlans(f.db.db, raw)
      }
    } finally {
      stop()
      meter.restore()
      selection.mockRestore()
      clock.mockRestore()
    }
  })
  expect(samples[1].totals.selected).toBe(samples[0].totals.selected)
  for (const field of ['all', 'get', 'rows', 'bytes', 'stringChars', 'requestChars'] as const) {
    expect(samples[1].totals[field]).toBeLessThanOrEqual(10 * samples[0].totals[field])
  }
  for (const field of ['selectors', 'livePane', 'process', 'names'] as const) {
    expect(samples[1].work[field]).toBeLessThanOrEqual(10 * samples[0].work[field])
  }
  for (const field of [
    'identity',
    'currentSession',
    'currentPane',
    'namedRun',
    'activeHandle',
    'activePane',
    'activeSuffix',
    'explicitDispatch',
    'history'
  ] as const) {
    expect(samples[1].keyWork[field]).toBeLessThanOrEqual(10 * samples[0].keyWork[field])
  }
  expect(samples[1].boundChars).toBeLessThanOrEqual(10 * samples[0].boundChars)
  expect(samples[1].outputChars).toBeLessThanOrEqual(10 * samples[0].outputChars)
  process.stdout.write(`C2 pending all-row complete work ${JSON.stringify(samples)}\n`)
})
