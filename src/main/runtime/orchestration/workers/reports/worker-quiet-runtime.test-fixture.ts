import { afterEach, beforeEach, vi } from 'vitest'
import { AgentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { startWorkerQuietSweep } from './worker-quiet-runtime'
import type { WorkerQuietObservation } from './worker-quiet-sweep'

const chat = vi.hoisted(() => ({
  handles: new Set<string>(),
  status: 'working',
  progress: vi.fn<(id: string) => Omit<WorkerQuietObservation, 'dispatchId' | 'working'> | null>()
}))

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => ({
      readStatusSummary: () => ({ status: chat.status }),
      attentionReads: { workerProgress: chat.progress },
      sessionAgent: () => 'codex'
    })
  })
)
vi.mock('../../terminal-authority/structured-sessions/structured-worker-authority', () => ({
  resolveStructuredWorkerIdentity: (handle: string) =>
    chat.handles.has(handle) ? { handle, sessionId: 'session-1', agent: 'codex' } : null,
  structuredWorkerSession: () => ({ kind: 'here', sessionId: 'session-1' })
}))
vi.mock('../../../construction/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({})
}))

export function runtimeFixture() {
  let db: OrchestrationDb
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    chat.handles.clear()
    chat.status = 'working'
    chat.progress.mockReset().mockReturnValue({ turnStartedAt: 0, lastProducerEventAt: 0 })
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.restoreAllMocks()
    db.close()
    vi.useRealTimers()
  })
  return {
    chat,
    get db() {
      return db
    },
    start: (overrides: Partial<Parameters<typeof startWorkerQuietSweep>[0]> = {}) => {
      stop?.()
      stop = startWorkerQuietSweep({
        store: new AgentHookServer(),
        changes: { subscribe: () => () => {} },
        getDb: () => db,
        resolveTerminal: () => null,
        readPty: () => null,
        notify: () => {},
        ...overrides
      })
      vi.advanceTimersByTime(0)
    },
    workers: (count: number) => {
      const run = db.createRun({
        objective: 'quiet recovery',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: null
      })
      const workers = Array.from({ length: count }, (_, n) => {
        const task = db.createTask({ spec: 'work', runId: run.id })
        const handle = `term_worker_${n}`
        chat.handles.add(handle)
        return createRootDispatch(db, task.id, handle)
      })
      return { run, workers }
    }
  }
}

/** Count rows examined inside the actual queries, including rows discarded before output. */
export function meterQuietQueries(db: OrchestrationDb) {
  const visits = { local: 0, relay: 0, attachment: 0 }
  for (const kind of ['local', 'relay', 'attachment'] as const) {
    db.db.function(`quiet_${kind}_visit`, (_row: unknown) => {
      visits[kind]++
      return 1
    })
  }
  const prepare = db.db.prepare.bind(db.db)
  const plans: string[] = []
  let recoveryQueries = 0
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
    const metered = sql
      .replace(/FROM messages\s+WHERE/g, 'FROM messages WHERE quiet_local_visit(payload) AND')
      .replace(
        /FROM federation_relay_items\s+WHERE/g,
        'FROM federation_relay_items WHERE quiet_relay_visit(payload) AND'
      )
      .replace(
        'FROM remote_dispatch_attachments WHERE',
        'FROM remote_dispatch_attachments WHERE quiet_attachment_visit(dispatch_id) AND'
      )
    if (sql.includes('WITH requested AS')) {
      recoveryQueries++
    }
    if (
      sql.includes('WITH requested AS') ||
      sql.includes('FROM remote_dispatch_attachments WHERE')
    ) {
      // All trigger queries bind at most the requested-worker JSON argument.
      for (const row of prepare(`EXPLAIN QUERY PLAN ${metered}`).all(
        ...(sql.includes('?') ? ['[]'] : [])
      )) {
        plans.push(String(row.detail))
      }
    }
    return prepare(metered)
  })
  return {
    visits,
    plans,
    restore: () => spy.mockRestore(),
    get recoveryQueries() {
      return recoveryQueries
    }
  }
}
