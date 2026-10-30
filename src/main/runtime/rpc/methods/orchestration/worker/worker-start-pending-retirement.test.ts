import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../../../shared/claimed-agent-pty-owner'
import { isPreparedAgentLaunchStatus } from '../../../../../../shared/prepared-agent-launch'
import { PreparedAgentLaunchOwner } from '../../../../../daemon/prepared-agent-launch-owner'
import { fingerprintPreparedAgentLaunch } from '../../../../../daemon/prepared-agent-launch-payload'
import type { InternalCreateOrAttachOptions } from '../../../../../daemon/terminal-host-agent-session-claim'
import type { RawPtySpawnObserver } from '../../../../../daemon/pty-subprocess'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { PreparedTerminalPendingError } from '../../../../terminal/launch/prepared-terminal-pending'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import { createWorkerLaunchReceipt } from './worker-launch-preferences'
import { decideWorkerStartMode } from '../../orchestration-worker-start-mode'

const NOW = 1_800_000_000_000
let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  db = undefined
  vi.useRealTimers()
})

async function acceptedPair() {
  vi.useFakeTimers({ now: NOW })
  const database = new OrchestrationDb(':memory:')
  db = database
  const task = database.createTask({ runId: 'run_legacy_local', spec: 'pending Setup' })
  const { dispatch } = database.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 9
  })
  const calls: InternalCreateOrAttachOptions[] = []
  const observers: RawPtySpawnObserver[] = []
  const release = vi.fn()
  const owner = new PreparedAgentLaunchOwner({
    owners: new ClaimedAgentPtyOwnerRegistry(),
    isAlive: () => true,
    reserveCapacity: () => release,
    create: async (options) => {
      calls.push(options)
      const observer = options.rawSpawnObserver?.()
      if (observer) {
        observers.push(observer)
        observer.onSelected()
      }
      options.reservedCapacity?.()
      return {
        isNew: true,
        snapshot: null,
        pid: 42,
        shellState: 'ready',
        wslDistro: null,
        attachToken: Symbol(),
        incarnationId: randomUUID()
      }
    }
  })
  const operationId = `${NOW}-${'a'.repeat(32)}`
  const attemptId = randomUUID()
  const launch = {
    sessionId: 'agent',
    cols: 80,
    rows: 24,
    command: 'cx',
    env: { USER_VALUE: 'unchanged\nvalue' }
  }
  const payload = {
    launch,
    setup: {
      spawn: { sessionId: 'setup', cols: 80, rows: 24 },
      attemptId,
      deadline: NOW + 7_200_000
    }
  }
  const prepared = await owner.handle({
    action: 'prepare',
    operationId,
    fingerprint: fingerprintPreparedAgentLaunch(payload),
    claim: {
      kind: 'fresh-launch',
      agent: 'codex',
      keyId: 'key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      digestVersion: 1
    },
    surface: {
      worktreeId: 'wt',
      tabId: 'tab_worker',
      leafId: '88888888-8888-4888-8888-888888888888',
      terminalHandle: 'term_worker'
    }
  })
  if (!isPreparedAgentLaunchStatus(prepared)) {
    throw new Error('missing preparation')
  }
  await owner.handle({ action: 'accept', identity: prepared, ...payload })
  database.recordWorkerStage({
    dispatchId: dispatch.id,
    stage: 'worktree_created',
    worktreeId: 'wt',
    effects: [{ kind: 'worktree', id: 'wt', action: 'created_child' }]
  })
  const zero = () => observers[0].onData(`\n__ORCA_SETUP_COMPLETE__:${attemptId}:0\n`)
  return { database, task, dispatch, owner, identity: prepared, calls, release, launch, zero }
}

describe('pending worker execution and Dispatch retirement', () => {
  it('accepted Setup+launch survives abandon before Setup zero without input loss or restored Dispatch authority', async () => {
    const f = await acceptedPair()
    expect(f.calls.map((entry) => entry.sessionId)).toEqual(['setup'])
    f.database.abandonWorkerDispatch(f.dispatch.id, 'runtime', 'term_coordinator')
    const revoked = f.database.getDispatchContextById(f.dispatch.id)
    expect(revoked?.capability_revoked_at).toBeTruthy()
    f.database.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(f.task.id)
    const newer = f.database.createStartingWorkerDispatch({
      taskId: f.task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    const newerBefore = f.database.getDispatchContextById(newer.dispatch.id)
    f.zero()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]).toMatchObject(f.launch)
    expect(f.database.getWorkerDispatch(f.dispatch.id)?.state).toBe('abandoned')
    expect(f.database.getDispatchContextById(f.dispatch.id)).toEqual(revoked)
    expect(
      f.database.settleWorkerReport({
        taskId: f.task.id,
        dispatchId: f.dispatch.id,
        outcome: 'succeeded',
        result: 'late'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(f.database.getDispatchContextById(newer.dispatch.id)).toEqual(newerBefore)
    expect(f.database.getDispatchContext(f.task.id)?.id).toBe(newer.dispatch.id)
  })

  it('caller timeout detaches an accepted Setup dependency without failing or tearing down the worker', async () => {
    const f = await acceptedPair()
    const waiting = f.owner.handle({ action: 'wait', identity: f.identity, timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(await waiting).toMatchObject({ accepted: true, execution: 'not-dispatched' })
    const before = f.database.getDispatchContextById(f.dispatch.id)
    const teardown = vi.fn(() => {
      throw new Error('must not tear down accepted work')
    })
    // SAFETY: the accepted-pending branch must return before accessing any runtime or structured-session operation.
    const runtime = { removeTerminal: teardown } as unknown as Parameters<
      typeof failWorkerStartWithReceipt
    >[0]['runtime']
    expect(
      await failWorkerStartWithReceipt({
        runtime,
        structuredSession: null,
        db: f.database,
        runId: 'run_legacy_local',
        taskId: f.task.id,
        dispatchId: f.dispatch.id,
        failedStage: 'worktree_created',
        error: new PreparedTerminalPendingError(f.identity),
        setup: {
          requested: 'run',
          effective: 'run',
          source: 'explicit_request',
          hookFound: true,
          startupPolicy: 'wait-for-setup',
          state: 'running'
        },
        launch: createWorkerLaunchReceipt({ agent: 'codex' }),
        mode: decideWorkerStartMode({ params: { agent: 'codex' }, settings: null })
      })
    ).toMatchObject({ state: 'outcome_unknown', pending: { operationId: f.identity.operationId } })
    expect(teardown).not.toHaveBeenCalled()
    expect(f.database.getDispatchContextById(f.dispatch.id)).toEqual(before)
    expect(f.database.getWorkerDispatch(f.dispatch.id)?.state).toBe('starting')
    f.zero()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2)
  })

  it.each(['cancel-first', 'zero-first'] as const)(
    'lost cancel acknowledgment retains uncertainty until exact owner status: %s',
    async (ordering) => {
      const f = await acceptedPair()
      if (ordering === 'zero-first') {
        f.zero()
      }
      // The caller loses this reply; only an exact subsequent status may retire its saved obligation.
      await f.owner.handle({ action: 'cancel', identity: f.identity })
      await expect(
        f.owner.handle({
          action: 'status',
          identity: { ...f.identity, daemonGeneration: 'lost-owner' }
        })
      ).rejects.toThrow('agent_session_ownership_unknown')
      f.zero()
      await vi.advanceTimersByTimeAsync(0)
      const status = await f.owner.handle({ action: 'status', identity: f.identity })
      expect(status).toMatchObject(
        ordering === 'cancel-first'
          ? { execution: 'settled', retirement: 'unused-retired' }
          : { execution: 'started', retirement: 'retained-live' }
      )
      expect(f.calls).toHaveLength(ordering === 'cancel-first' ? 1 : 2)
      expect(f.database.getDispatchContextById(f.dispatch.id)?.capability_revoked_at).toBeNull()
    }
  )
})
