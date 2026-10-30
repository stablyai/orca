import { fixture } from './crew-read-model.test-fixture'
import { CrewReadModel } from './crew-read-model'
import { OrcaRuntimeService } from '../../orca-runtime'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerIdentityFromRow,
  structuredWorkerProcessIncarnation
} from '../../structured-worker-identity'
import { backfillStructuredWorkerOrcaSessionIds } from '../db/schema/structured-worker-orca-session-backfill'
import * as recipientRouting from '../../rpc/methods/orchestration/messaging/recipient-routing'
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(() => {
  vi.restoreAllMocks()
})

it('keeps retained NULL-session nested structured process reads inside selected batches at N/10N', () => {
  const samples = [3, 30].map((population) => {
    const f = fixture()
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(f.db)
    const records = new Map<string, ReturnType<typeof agentSessionConversationView>>()
    const identities = Array.from({ length: population }, (_, i) => {
      const session = `chat-nested-${i}`
      const handle = mintStructuredWorkerHandle()
      const pane = mintStructuredWorkerPaneKey(session)
      const task = () => f.db.createTask({ runId: f.run.id, spec: 'retained nested owner' }).id
      const older = f.db.createDispatchContext({
        taskId: task(),
        assigneeHandle: `term_older_${i}`,
        creator: { kind: 'system' },
        maxDepth: 10
      })
      const oldResource = f.db.createWorkerTerminalResourceStatement({
        dispatchId: older.id,
        worktreeId: 'wt_nested',
        terminalHandle: handle,
        paneKey: null,
        processIncarnation: structuredWorkerProcessIncarnation(`chat-older-${i}`),
        ownership: 'owned'
      })
      f.db.db
        .prepare("UPDATE worker_terminal_resources SET updated_at = '2000-01-01' WHERE id = ?")
        .run(oldResource.id)
      const dispatch = f.db.createDispatchContext({
        taskId: task(),
        assigneeHandle: handle,
        assigneePaneKey: pane,
        processIncarnation: structuredWorkerProcessIncarnation(session),
        creator: { kind: 'system' },
        maxDepth: 10
      })
      const resource = f.db.createWorkerTerminalResourceStatement({
        dispatchId: dispatch.id,
        worktreeId: 'wt_nested',
        terminalHandle: handle,
        paneKey: pane,
        processIncarnation: structuredWorkerProcessIncarnation(session),
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
        ownership: 'owned'
      })
      // Retained older writers omitted this column; conflicting evidence must remain NULL after open.
      f.db.db
        .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = NULL WHERE id = ?')
        .run(dispatch.id)
      const identity = structuredWorkerIdentityFromRow(resource)
      if (!identity) {
        throw new Error('Expected actual validated structured resource identity')
      }
      structuredWorkerIdentities.register(identity)
      records.set(
        session,
        agentSessionConversationView(agentSessionRecordFixture({ sessionId: session }))
      )
      f.handles.set(handle, pane)
      f.db.insertMessage({
        from: formatOrcaSessionAddress(session),
        to: 'term_worker',
        subject: 'Nested peer',
        body: session
      })
      return { ...identity, dispatch }
    })
    backfillStructuredWorkerOrcaSessionIds(f.db.db)
    for (const identity of identities) {
      expect(f.db.getDispatchContextById(identity.dispatch.id)?.assignee_orca_session_id).toBeNull()
      expect(
        f.db.getCurrentRunForCoordinator({
          terminalHandle: identity.handle,
          paneKey: identity.paneKey,
          orcaSessionId: identity.sessionId
        })
      ).toBeUndefined()
    }
    f.deps.records = {
      listRecords: () => [...records.values()],
      getRecord: (id) => records.get(id) ?? null,
      getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...records.keys()] })
    }
    hostRef.current = {
      deps: {
        store: {
          getConversation: (id: string) => records.get(id) ?? null,
          listConversations: () => [...records.values()]
        }
      },
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...records.keys()] })
    }
    const context = runtime.createTerminalIdentityReadContext()
    f.deps.openIdentityRead = () => ({
      liveHandle: f.deps.liveHandle,
      handleForPane: f.deps.handleForPane,
      paneForHandle: f.deps.paneForHandle,
      name: f.deps.name,
      processForHandle: (handle) => runtime.getTerminalProcessIncarnation(handle, context)
    })
    f.deps.livePaneForHandle = (handle) => runtime.getLiveTerminalPaneKey(handle, context)
    const productionProcess = runtime.getTerminalProcessIncarnation.bind(runtime)
    const operations = {
      all: 0,
      get: 0,
      rows: 0,
      bytes: 0,
      nestedGet: 0,
      nestedProcess: 0,
      selected: 0,
      keys: 0,
      requestBytes: 0
    }
    const nestedKeys = new Map<
      string | null,
      ReturnType<typeof recipientRouting.dispatchAssigneeCoordinatorKey>
    >()
    let selecting = false
    const select = recipientRouting.dispatchAssigneeCoordinatorKey
    const selection = vi
      .spyOn(recipientRouting, 'dispatchAssigneeCoordinatorKey')
      .mockImplementation((...args) => {
        selecting = true
        try {
          const key = select(...args)
          nestedKeys.set(args[0].assignee_handle, key)
          return key
        } finally {
          selecting = false
        }
      })
    const process = vi
      .spyOn(runtime, 'getTerminalProcessIncarnation')
      .mockImplementation((...args) => {
        if (selecting) {
          operations.nestedProcess++
        }
        return productionProcess(...args)
      })
    const original = f.db.db.prepare.bind(f.db.db)
    const meter = vi.spyOn(f.db.db, 'prepare').mockImplementation((sql) => {
      const statement = original(sql)
      const multiplier = sql.includes('AS recorded')
        ? 2
        : sql.includes("'handle' AS branch")
          ? 3
          : sql.includes('candidates AS (')
            ? 2
            : sql.includes('coordinator.run_id FROM json_each')
              ? 1
              : 0
      return {
        all: (...args) => {
          operations.all++
          if (multiplier) {
            const requested: unknown = typeof args[0] === 'string' ? JSON.parse(args[0]) : null
            if (!Array.isArray(requested)) {
              throw new Error('Expected selected keys')
            }
            operations.selected++
            operations.keys += requested.length * multiplier
            operations.requestBytes += Buffer.byteLength(JSON.stringify(requested))
          }
          const rows = statement.all(...args)
          operations.rows += rows.length
          operations.bytes += Buffer.byteLength(JSON.stringify(rows))
          return rows
        },
        get: (...args) => {
          operations.get++
          if (selecting) {
            operations.nestedGet++
          }
          const row = statement.get(...args)
          operations.rows += row ? 1 : 0
          operations.bytes += Buffer.byteLength(JSON.stringify(row ?? null))
          return row
        },
        run: (...args) => statement.run(...args),
        iterate: (...args) => statement.iterate(...args),
        setReadBigInts: (value) => statement.setReadBigInts(value)
      }
    })
    const registration = vi.spyOn(structuredWorkerIdentities, 'register')
    const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const output = model.read('term_worker')
      expect(output.sections.talkingWith).toHaveLength(population)
      expect(
        output.sections.talkingWith.every((row) => row.sendAddress && row.latest && row.openTarget)
      ).toBe(true)
      console.log(
        'C2 nested NULL process work',
        JSON.stringify({
          population,
          ...operations,
          registrations: registration.mock.calls.length,
          outputChars: JSON.stringify(output).length
        })
      )
      expect(registration).not.toHaveBeenCalled()
      expect(operations.selected).toBeLessThanOrEqual(5)
      const measured = { ...operations, population }
      // Actual baseline presentation resolves/registers cold identities before the selected callback.
      structuredWorkerIdentities.clear()
      f.db.crewChanges.notify(new Set(['topology']))
      const beforeCold = { ...operations }
      expect(model.read('term_worker')).toEqual(output)
      expect(registration).toHaveBeenCalledTimes(population)
      expect(operations.nestedGet - beforeCold.nestedGet).toBe(0)
      expect(operations.nestedProcess - beforeCold.nestedProcess).toBe(0)
      console.log(
        'C2 nested cold baseline',
        JSON.stringify({
          population,
          all: operations.all - beforeCold.all,
          get: operations.get - beforeCold.get,
          registrations: registration.mock.calls.length
        })
      )
      meter.mockRestore()
      for (const identity of identities) {
        const retainedDispatch = f.db.getDispatchContextById(identity.dispatch.id)
        if (!retainedDispatch) {
          throw new Error('Expected retained Dispatch after NULL-preserving backfill')
        }
        expect(nestedKeys.get(identity.handle)).toEqual(
          select(
            retainedDispatch,
            () => false,
            (handle) => runtime.getLiveTerminalPaneKey(handle, context),
            (handle) => productionProcess(handle, context)
          )
        )
      }
      return measured
    } finally {
      stop()
      meter.mockRestore()
      process.mockRestore()
      selection.mockRestore()
      registration.mockRestore()
      hostRef.current = null
      structuredWorkerIdentities.clear()
    }
  })
  expect(samples.map((sample) => sample.nestedProcess)).toEqual([0, 0])
  expect(samples.map((sample) => sample.nestedGet)).toEqual([0, 0])
  expect(samples[1].all).toBe(samples[0].all)
  expect(samples[1].get).toBeLessThanOrEqual(10 * samples[0].get)
})
