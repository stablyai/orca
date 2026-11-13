import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent, ingestProgramStatusOsc } from '../../server.test-fixtures'
import { readQuietWorkers } from '../../../../../runtime/orchestration/workers/reports/worker-quiet-observations'
import { WorkerQuietSweep } from '../../../../../runtime/orchestration/workers/reports/worker-quiet-sweep'
import { OrchestrationDb } from '../../../../../runtime/orchestration/db/orchestration-db'
import '../../../../../runtime/orchestration/db/contract-constants'
import '../../../../../runtime/orchestration/db/messages/mailbox-routing-page'
import '../../../../../runtime/orchestration/db/dispatch-row-writer'
import '../../../../../runtime/orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../../../../../runtime/orchestration/db/root-dispatch-test-fixture'
import type { RuntimePtyWorktreeRecord } from '../../../../../runtime/terminal/records/runtime-terminal-state-records'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readOpenCodeBinderSessions: async () => []
}))
vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => undefined
  })
)

const capture: { event: string; payload: Record<string, unknown> }[] = readFileSync(
  new URL('../../../../__fixtures__/codex-0.167-subagent-hooks.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

// Identities below are unchanged from the recorded Codex 0.167 hook payloads.
const SPAWN = '["","call_b4ad48e710504d7694929caa18d46303"]'
const WAIT = '["","call_a94a94a55b76468ba520faeafdd10417"]'
const CHILD = '["01a1d383-6db6-70c3-8cc9-8a7e0d511fb0","exec-8460280b-ac47-4c43-9b82-b219a346d6a8"]'
const SHELL = '["","exec-9f10000a-c5a9-4ab8-a271-10d5b9dfc0c8"]'

afterEach(() => vi.useRealTimers())

it.each([false, true])(
  'tracks captured Codex parent/child progress without phantom tools (missed child result: %s)',
  async (missedChildResult) => {
    _internals.resetCachesForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_790_000_000_000)
    const db = new OrchestrationDb(':memory:')
    const server = new AgentHookServer()
    const run = db.createRun({
      objective: 'captured child progress',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ spec: 'work', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: observation only reads connection status when a real hook row exists.
    const pty = { connected: true } as RuntimePtyWorktreeRecord
    const observation = () =>
      readQuietWorkers(
        {
          store: server,
          readPaneKeys: () => [PANE],
          readPty: () => pty,
          resolveTerminal: () => ({
            db,
            handle: 'term_worker',
            target: { kind: 'local', dispatch }
          })
        },
        db
      )[0]?.observation
    const calls = () => [...server.producerProgress.get(PANE)!.tools.keys()]
    const post = async (index: number) => {
      vi.setSystemTime(1_790_000_000_000 + index * 1_000)
      const response = await postHookEvent(
        server,
        buildBody(capture[index]!.payload),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
    }
    const notices = () => {
      const row = observation()
      const sent: number[] = []
      const now = Date.now()
      const sweep = new WorkerQuietSweep(
        now,
        () => new Map(),
        (_row, notice) => {
          sent.push(notice.observedAt - now)
          return true
        }
      )
      for (let elapsed = 0; elapsed <= 3_600_000; elapsed += 60_000) {
        sweep.sweep(row ? [row] : [], now + elapsed)
      }
      return sent
    }
    try {
      await server.start({ env: 'production' })
      await post(0)
      await post(1)
      await post(2)
      expect(calls()).toEqual([SPAWN])
      expect(notices()).toEqual([3_600_000])
      await post(3)
      expect(calls()).toEqual([])
      await post(4)
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_004_000)
      await post(5)
      expect(calls()).toEqual([WAIT])
      await post(6)
      expect(calls()).toEqual([WAIT, CHILD])
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_006_000)
      vi.setSystemTime(1_790_000_006_500)
      // Captured Codex 0.163 idle bytes must yield to the captured live child hooks.
      ingestProgramStatusOsc(server, '\x1b]7501;state=idle:app=codex\x1b\\')
      expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('working')
      expect(calls()).toEqual([WAIT, CHILD])
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_006_500)
      expect(notices()).toEqual([3_600_000])
      if (!missedChildResult) {
        await post(7)
        expect(calls()).toEqual([WAIT])
        expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_007_000)
      }
      await post(8)
      expect(calls()).toEqual([WAIT])
      expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_008_000)
      expect(observation()?.turnStartedAt).toBe(1_790_000_001_000)
      expect(notices()).toEqual([3_600_000])
      await post(9)
      expect(calls()).toEqual([])
      expect(notices()).toEqual([900_000, 2_700_000])
      await post(10)
      expect(calls()).toEqual([SHELL])
      await post(11)
      expect(calls()).toEqual([])
      expect(notices()).toEqual([900_000, 2_700_000])
      await post(12)
      expect(calls()).toEqual([])
      expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')
      expect(notices()).toEqual([])
    } finally {
      server.stop()
      db.close()
    }
  }
)
