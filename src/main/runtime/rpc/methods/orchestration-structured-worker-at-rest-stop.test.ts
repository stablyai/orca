/**
 * worker-stop on a minted structured worker whose agent rests (the idle sweep, a restart, the
 * user's Stop) with its Dispatch open. The worker reads live, as every assignee reader says, so
 * the stop closes the session Orca owns and settles, and release then works. Only an owned
 * session is ever closed: a worker the user took over is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeService } = await import('../../orca-runtime')
const { OrchestrationDb } = await import('../../orchestration/db')
const {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('../../structured-worker-identity')
const { ORCHESTRATION_METHODS } = await import('./orchestration')
const { eraseRpcMethods } = await import('../core')

const SESSION = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const HANDLE = 'structworker_33333333-3333-4333-a333-333333333333'
const WORKTREE = 'wt_1'

/** What a rest writes: the lease released with death evidence. */
function restingRecord(): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      claimStatus: 'released',
      deathEvidence: { kind: 'pid-absent', detail: 'rest', observedAt: 2 }
    })
  )
  return { ...base, location: { ...base.location, workspaceId: WORKTREE } }
}

let listed: Set<string>
let closes: string[]
let db: InstanceType<typeof OrchestrationDb>
let runtime: InstanceType<typeof OrcaRuntimeService>

beforeEach(() => {
  structuredWorkerIdentities.clear()
  listed = new Set([SESSION])
  closes = []
  const record = restingRecord()
  hostRef.current = {
    deps: {
      store: {
        getRecord: (id: string) => (id === SESSION ? record : null),
        listRecords: () => [record]
      },
      logger: { warn: () => undefined }
    },
    hasSession: () => false,
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...listed] }),
    setSessionTabVisibility: async (id: string, visible: boolean) => {
      if (visible) {
        listed.add(id)
      } else {
        listed.delete(id)
      }
    },
    close: async (id: string) => {
      closes.push(id)
    },
    history: async () => ({ page: { items: [], hasOlder: false } })
  }
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
})

afterEach(() => {
  db.close()
  structuredWorkerIdentities.clear()
  hostRef.current = null
  vi.restoreAllMocks()
})

async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
  const method = eraseRpcMethods(ORCHESTRATION_METHODS).find((entry) => entry.name === name)
  if (!method?.params) {
    throw new Error(`Method not found: ${name}`)
  }
  return method.handler(method.params.parse(params), { runtime })
}

/** A minted worker's ready worker-start Dispatch; returns its id and the worker's pane. */
function startMintedWorker(): { dispatchId: string; paneKey: string } {
  const paneKey = mintStructuredWorkerPaneKey(SESSION)
  const processIncarnation = structuredWorkerProcessIncarnation(SESSION)
  structuredWorkerIdentities.register({
    handle: HANDLE,
    sessionId: SESSION,
    agent: 'claude',
    paneKey,
    processIncarnation,
    worktreeId: WORKTREE,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'minted at rest' })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {},
    runtimeEpoch: runtime.getRuntimeId()
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: HANDLE,
    paneKey,
    processIncarnation,
    worktreeId: WORKTREE,
    setupState: 'not_applicable',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return { dispatchId: started.dispatch.id, paneKey }
}

describe('worker-stop on a minted structured worker at rest', () => {
  it('closes the session Orca owns and settles stopped, after which release works', async () => {
    const { dispatchId } = startMintedWorker()

    expect(await call('orchestration.workerStop', { dispatch: dispatchId })).toMatchObject({
      state: 'stopped',
      processAction: 'closed_agent_terminal'
    })
    expect(closes).toEqual([SESSION])
    expect(listed.has(SESSION)).toBe(false)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(await call('orchestration.workerRelease', { dispatch: dispatchId })).toMatchObject({
      state: 'released'
    })
  })

  it('never closes a worker the user took over', async () => {
    const { dispatchId, paneKey } = startMintedWorker()
    db.markWorkerTerminalUserOwned(paneKey)

    expect(await call('orchestration.workerStop', { dispatch: dispatchId })).toMatchObject({
      state: 'stop_unknown',
      processAction: 'none'
    })
    expect(closes).toEqual([])
    expect(listed.has(SESSION)).toBe(true)
  })
})
