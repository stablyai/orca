import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session-record.test-fixture'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../../structured-worker-identity'
import { readStructuredAgentSessionRecord } from '../../../../structured-worker-authority'
import type * as StructuredWorkerAuthority from '../../../../structured-worker-authority'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

vi.mock('../../../../structured-worker-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredWorkerAuthority>()
  return { ...actual, readStructuredAgentSessionRecord: vi.fn() }
})

const SESSION_ID = 'session-alpha-1'
const STRUCTURED_HANDLE = 'structworker_11111111-2222-4333-8444-555555555555'
const STRUCTURED_PANE_KEY = mintStructuredWorkerPaneKey(SESSION_ID)

function nativeRecord(
  leaseOverrides: Parameters<typeof agentSessionLeaseFixture>[0] = {}
): AgentSessionRecord {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({ runtimeKind: 'native', ...leaseOverrides })
  )
}

describe('run methods called with a structured session bearer', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  beforeEach(() => {
    ;({ db, runtime, ctx } = h.setup(false))
    structuredWorkerIdentities.clear()
    structuredWorkerIdentities.register({
      handle: STRUCTURED_HANDLE,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey: STRUCTURED_PANE_KEY,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'worktree-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(nativeRecord())
  })

  afterEach(() => {
    structuredWorkerIdentities.clear()
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  function rawRun(id: string) {
    return db.getRunRaw(id)!
  }

  it('creates, rebinds, and reads a Run through the session principal with a receipt identical to the pane path', async () => {
    const paneCreated = (await call('orchestration.runCreate', {
      objective: 'Pane-coordinated',
      from: 'term_coord'
    })) as { run: Record<string, unknown> & { id: string } }
    const created = (await call('orchestration.runCreate', {
      objective: 'Session-coordinated',
      from: STRUCTURED_HANDLE,
      runtimeFence: 7
    })) as { run: Record<string, unknown> & { id: string } }

    expect(Object.keys(created.run).sort()).toEqual(Object.keys(paneCreated.run).sort())
    expect(rawRun(created.run.id).coordinator_principal).toBe(`session:${SESSION_ID}`)

    const current = (await call('orchestration.runCurrent', { from: STRUCTURED_HANDLE })) as {
      run: { id: string } | null
    }
    expect(current.run?.id).toBe(created.run.id)

    const rebound = (await call('orchestration.runUse', {
      id: paneCreated.run.id,
      from: STRUCTURED_HANDLE
    })) as { run: { id: string } }
    expect(rebound.run.id).toBe(paneCreated.run.id)
    expect(rawRun(paneCreated.run.id).coordinator_principal).toBe(`session:${SESSION_ID}`)
    // The rebind released the session's previous Run.
    expect(rawRun(created.run.id).coordinator_principal).toBeNull()
  })

  it('dual-writes the handle and minted pane key so the mail path still resolves the Run', async () => {
    const created = (await call('orchestration.runCreate', {
      objective: 'Dual-write',
      from: STRUCTURED_HANDLE
    })) as { run: { id: string } }
    const raw = rawRun(created.run.id)
    expect(raw.coordinator_principal).toBe(`session:${SESSION_ID}`)
    expect(raw.coordinator_handle).toBe(STRUCTURED_HANDLE)
    expect(raw.coordinator_pane_key).toBe(STRUCTURED_PANE_KEY)
    expect(db.getCurrentRunForPane(STRUCTURED_PANE_KEY)?.id).toBe(created.run.id)
  })

  it('cancels the prior Run waiters and fences its delivery when the session creates a new Run', async () => {
    const prior = (await call('orchestration.runCreate', {
      objective: 'Prior run',
      from: STRUCTURED_HANDLE
    })) as { run: { id: string; consumer_generation: number } }
    db.insertMessage({
      from: 'term_worker',
      to: `run:${prior.run.id}`,
      subject: 'pending',
      runId: prior.run.id
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: prior.run.id,
      consumerGeneration: prior.run.consumer_generation
    })!
    const cancelled = vi.spyOn(runtime, 'cancelMessageWaiters')

    await call('orchestration.runCreate', { objective: 'Next run', from: STRUCTURED_HANDLE })

    // The #19648 defect: its session branch skipped the prior-run lookup and both cancels.
    expect(cancelled.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([STRUCTURED_HANDLE, `run:${prior.run.id}`])
    )
    const deliveryStatus = db.db
      .prepare('SELECT status FROM deliveries WHERE id = ?')
      .get(delivery.delivery.id) as { status: string }
    expect(deliveryStatus.status).toBe('fenced')
    expect(rawRun(prior.run.id).coordinator_principal).toBeNull()
  })

  it('refuses takeover-legacy from a session caller', async () => {
    await expect(
      call('orchestration.runUse', { id: 'run-x', from: STRUCTURED_HANDLE, takeoverLegacy: true })
    ).rejects.toMatchObject({ code: 'legacy_read_only' })
  })

  it('refuses a declared session id with no bearer and writes no row', async () => {
    await expect(
      call('orchestration.runCreate', {
        objective: 'Impersonation attempt',
        agentSessionId: SESSION_ID,
        runtimeFence: 7
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(0)
  })

  it.each([
    ['a stale declared fence', { runtimeFence: 6 }, nativeRecord()],
    ['a reserved lease', {}, nativeRecord({ claimStatus: 'reserved' })],
    ['a lease mid-handoff', {}, nativeRecord({ handoffStage: 'preparing' })]
  ])('refuses all three methods for %s and writes no row', async (_label, extra, record) => {
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(record)
    await expect(
      call('orchestration.runCreate', {
        objective: 'Refused',
        from: STRUCTURED_HANDLE,
        ...extra
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    await expect(
      call('orchestration.runUse', { id: 'run-x', from: STRUCTURED_HANDLE, ...extra })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    await expect(
      call('orchestration.runCurrent', { from: STRUCTURED_HANDLE, ...extra })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(0)
  })

  it('accepts a corroborating fence of 0 against a fence-0 lease', async () => {
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(nativeRecord({ runtimeFence: 0 }))
    const created = (await call('orchestration.runCreate', {
      objective: 'Fresh lease',
      from: STRUCTURED_HANDLE,
      runtimeFence: 0
    })) as { run: { id: string } }
    expect(rawRun(created.run.id).coordinator_principal).toBe(`session:${SESSION_ID}`)
  })
})
