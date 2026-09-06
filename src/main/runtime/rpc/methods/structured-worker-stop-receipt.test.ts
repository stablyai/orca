/**
 * What `worker-stop` may claim it did to a structured worker.
 *
 * A runtime generation with no structured host installed cannot reach the session at all. Saying
 * `closed_agent_terminal` there credits this runtime with an action it never took, and a
 * coordinator reading the receipt treats the worker's chat tab as gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../structured-worker-identity'
import { ORCHESTRATION_METHODS } from './orchestration'

const SESSION = 'session-stop-receipt'
const HANDLE = 'structworker_22222222-2222-4222-a222-222222222222'
const WORKTREE = 'repo::worktree'

describe('worker-stop on a structured worker this runtime cannot reach', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    structuredWorkerIdentities.clear()
    setStructuredAgentSessionHost(null)
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // The install is what release already does; here it is a no-op so the host stays absent.
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  })

  afterEach(() => {
    db.close()
    structuredWorkerIdentities.clear()
    setStructuredAgentSessionHost(null)
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime })
  }

  function startStructuredWorker(): string {
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
    const task = db.createTask({ spec: 'stop a structured worker' })
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
      effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch.id
  }

  it('reports that nothing was closed', async () => {
    const dispatchId = startStructuredWorker()
    await expect(call('orchestration.workerStop', { dispatch: dispatchId })).resolves.toMatchObject(
      {
        processAction: 'none',
        state: 'stop_unknown'
      }
    )
  })
})
