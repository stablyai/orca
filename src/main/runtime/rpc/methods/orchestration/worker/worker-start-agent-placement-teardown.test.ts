/**
 * A structured worker whose launch throws after its session exists: the caller never gets a
 * placement to tear down, so the placement itself must discard the session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchModeReceipt } from '../../../../../agent-launch/agent-launch-mode'
import type { AgentLaunchExecution } from '../../../../../agent-launch/agent-launch-executor'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type * as StructuredWorkerSessionModule from '../../orchestration-structured-worker-session'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import { WorkerStartParams } from './worker-start-schema'

const discard = vi.hoisted(() => vi.fn(async (_sessionId: string) => {}))
const surfaced = vi.hoisted((): { sessionId: string | null } => ({ sessionId: null }))

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId, fence: 7 }
  })
}))

vi.mock('../../orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredWorkerSessionModule>()),
  discardStructuredWorkerSession: discard
}))

// No executor step after the surface throws today, so the seam stands in for a future one.
vi.mock('../../../../../agent-launch/agent-launch-executor', () => ({
  executeAgentLaunch: async (execution: AgentLaunchExecution) => {
    if (!execution.surfaces) {
      throw new Error('a worker launch always brings its surfaces')
    }
    const session = await execution.surfaces.createStructuredSession({
      agent: 'claude',
      worktreeId: 'wt_existing'
    })
    surfaced.sessionId = session.sessionId
    throw new Error('failed after the surface')
  }
}))

const { placeWorkerAgent } = await import('./worker-start-agent-placement')

const STRUCTURED: AgentLaunchModeReceipt = {
  mode: 'structured',
  preferred: 'structured',
  reason: 'user_default',
  detail:
    'Started a structured chat session worker, the default for new agent tabs in your settings.'
}

beforeEach(() => {
  discard.mockClear()
  surfaced.sessionId = null
  structuredWorkerIdentities.clear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a worker create reads only `subscribe` and the record's location.
  setStructuredAgentSessionHost({
    subscribe: () => () => {},
    deps: {
      store: { getRecord: () => ({ location: { executionHostId: 'local', wslDistro: null } }) }
    }
  } as never)
})

describe('a worker launch that throws after its session exists', () => {
  it('discards the session once before rethrowing', async () => {
    const runtime = {
      ensureStructuredAgentSessionHost: async () => {},
      forgetStructuredSessionMail: vi.fn()
    }
    const db = { recordWorkerStage: vi.fn() }

    await expect(
      placeWorkerAgent({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement calls only the methods faked here.
        runtime: runtime as unknown as OrcaRuntimeService,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement records only worker stages.
        db: db as unknown as OrchestrationDb,
        dispatchId: 'ctx_1',
        taskId: 'task_1',
        params: WorkerStartParams.parse({ from: 'term_coord', task: 'task_1' }),
        requestedWorktree: 'id:wt_existing',
        creationWorktree: undefined,
        resolvedWorktree: { id: 'wt_existing', repoId: 'repo_1' },
        mode: STRUCTURED,
        agent: 'claude',
        launchPreferences: undefined,
        effects: [],
        onStage: () => {}
      })
    ).rejects.toThrow('failed after the surface')

    expect(surfaced.sessionId).not.toBeNull()
    expect(discard).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledWith(surfaced.sessionId, runtime)
    expect(structuredWorkerIdentities.list()).toEqual([])
  })
})
