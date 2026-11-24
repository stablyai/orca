import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const newerDaemonHold = vi.hoisted(() => ({ held: false }))
vi.mock(
  '../../../../../../daemon/providers/routing/daemon-newer-protocol-hold',
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    isHoldingForNewerProtocolDaemon: () => newerDaemonHold.held
  })
)
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-reconciliation'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { LocalPtyProvider } from '../../../../../../providers/local-pty/local-pty-provider'
import { exitListeners } from '../../../../../../providers/local-pty/local-pty-provider-state'
import type { IPtyProvider } from '../../../../../../providers/pty/provider-contract'
import type { PtyProcessInfo } from '../../../../../../providers/pty/process-info'
import { listLocalProcessesForExitProofFromRuntimeController } from '../../../../../../ipc/pty/runtime/inventory-operations'
import { observeInProcessWorkerExits } from '../../../../../../ipc/pty/runtime/in-process-exit-observer'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../../../../terminal/lifecycle/pty-controller-inventory-budget'
import { DaemonSessionOwnerResolver } from '../../../../../../daemon/providers/routing/daemon-session-owner-resolution'
import { sweepStoppedWorkerTerminals } from '../../../../../orchestration/terminal-authority/release/stopped-worker-terminal-release'
import { createLegacyDaemonAdapters } from '../../../../../../daemon/providers/routing/daemon-legacy-adapters'
import { mayUnaskedDaemonRunSessions } from '../../../../../../daemon/providers/routing/daemon-unlisted-session'
import {
  createWorkerReleaseFixture,
  deferred,
  isStartReceipt,
  workerIncarnation,
  workerPaneKey,
  type WorkerReleaseFixture
} from './worker-release.test-fixture'

const workerGeneration = '11111111-1111-4111-8111-111111111111'
const otherGeneration = '33333333-3333-4333-8333-333333333333'

/**
 * Two daemon generations behind the real routing resolver, each listing `pty-worker` under its own
 * incarnation, with the route on the first (or, with `routed: false`, on neither). The routed view lists only the first.
 */
function twoGenerationDaemon(
  routedIncarnation: string,
  unroutedIncarnation: string,
  routed = true
): Pick<IPtyProvider, 'listProcesses'> {
  const generation = (incarnationId: string) => ({
    listProcesses: async () => [{ id: 'pty-worker', incarnationId, cwd: '', title: '' }]
  })
  const routedGeneration = generation(routedIncarnation)
  const generations = [routedGeneration, generation(unroutedIncarnation)]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inventory listing reads only listProcesses from each generation.
  const providers = generations as unknown as IPtyProvider[]
  const resolver = new DaemonSessionOwnerResolver(providers, new Map())
  if (routed) {
    resolver.recordRoute('pty-worker', providers[0]!, routedIncarnation)
  }
  return { listProcesses: (opts) => resolver.listProcesses(opts) }
}

describe('worker release once the exact process is proven exited', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let activeRunId: string
  let fixture: WorkerReleaseFixture

  function setup(): void {
    fixture = createWorkerReleaseFixture()
    ;({ db, runtime, activeRunId } = fixture)
    dbOpen = true
  }

  afterEach(() => {
    newerDaemonHold.held = false
    observeInProcessWorkerExits(undefined)
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  const call = (name: string, params: Record<string, unknown>) => fixture.call(name, params)
  const startSettledWorker = (outcome?: 'succeeded' | 'failed') =>
    fixture.startSettledWorker(outcome)
  const loseWorkerTerminal: WorkerReleaseFixture['loseWorkerTerminal'] = (listing) =>
    fixture.loseWorkerTerminal(listing)
  const goneAfterSettle = () => fixture.goneAfterSettle()
  const saveSession = (resourceId: string, sessionId: string) =>
    fixture.saveSession(resourceId, sessionId)

  it('releases a requested worker whose exited terminal is gone, keeping its newest saved transcript', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    loseWorkerTerminal(() => listing.promise)
    const { dispatchId } = await startSettledWorker()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id
    saveSession(resourceId, 'claude-session-a')
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    )
    // A /clear lands while the exit proof is pending; the archive must name the newer conversation.
    const transcriptPath = saveSession(resourceId, 'claude-session-b')
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'released',
      processAction: 'none',
      archive: { source: 'transcript', status: 'captured' }
    })
    expect(JSON.parse(db.getWorkerTerminalArchive(dispatchId)!.content)).toMatchObject({
      agent: 'claude',
      sessionId: 'claude-session-b',
      transcriptPath
    })
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'already_released' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('lets startup recovery finish a requested release once the owner proves exit', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    goneAfterSettle()

    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 1,
      pending: 0
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'released',
      archive_source: 'terminal',
      archive_status: 'unavailable'
    })
    await expect(reconcileRequestedWorkerTerminalReleases(runtime)).resolves.toMatchObject({
      attempted: 0
    })
  })

  it('keeps a worker the coordinator kept open while its exit proof was pending', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    loseWorkerTerminal(() => listing.promise)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    )
    await call('orchestration.workerRetain', { dispatch: dispatchId })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({ state: 'retained', processAction: 'none' })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained'
    })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('lets this process vouch only for worker exits its own terminals reported', async () => {
    setup()
    const inProcess = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => undefined },
        () => inProcess
      )
    )
    observeInProcessWorkerExits(runtime)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()
    const reportExit = (incarnationId: string) => {
      for (const listener of exitListeners) {
        listener({ id: 'pty-worker', code: 0, incarnationId })
      }
    }

    // A reused PTY id that exited under another incarnation says nothing about this worker.
    reportExit('33333333-3333-4333-8333-333333333333')
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })

    reportExit('11111111-1111-4111-8111-111111111111')
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
  })

  it('cannot prove a recorded worker exited until local terminals finish starting', async () => {
    setup()
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => (finishStartup = resolve))
    let serving: Pick<IPtyProvider, 'listProcesses'> = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => startup },
        () => serving
      )
    )
    const scope = JSON.stringify({ kind: 'local', hostId: 'local' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
      await vi.advanceTimersByTimeAsync(PTY_CONTROLLER_LIST_TIMEOUT_MS)
      await expect(pending).resolves.toBe('unverifiable')
    } finally {
      vi.useRealTimers()
    }

    serving = {
      listProcesses: async () => [
        {
          id: 'pty-worker',
          incarnationId: '11111111-1111-4111-8111-111111111111',
          cwd: '',
          title: ''
        }
      ]
    }
    finishStartup()
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
    ).resolves.toBe('live')
    serving = { listProcesses: async () => [] }
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(workerIncarnation, scope)
    ).resolves.toBe('exited')
  })

  it('pays one bounded startup wait per hung startup, not one per backlog row', async () => {
    setup()
    const startup = new Promise<void>(() => {})
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => startup },
        () => ({ listProcesses: async () => [] })
      )
    )
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    goneAfterSettle()
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    const backlogRows = 20
    vi.spyOn(db, 'listWorkerTerminalReleaseBacklog').mockReturnValue(
      Array.from({ length: backlogRows }, () => resource)
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const pass = reconcileRequestedWorkerTerminalReleases(runtime).finally(() => {
        settled = true
      })
      let waitedMs = 0
      while (!settled && waitedMs <= backlogRows * PTY_CONTROLLER_LIST_TIMEOUT_MS) {
        await vi.advanceTimersByTimeAsync(100)
        waitedMs += 100
      }
      await expect(pass).resolves.toMatchObject({ attempted: backlogRows, pending: backlogRows })
      expect(waitedMs).toBeLessThanOrEqual(PTY_CONTROLLER_LIST_TIMEOUT_MS + 100)
    } finally {
      vi.useRealTimers()
    }
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
  })

  it('does not let an in-process fallback speak for a worker it never ran', async () => {
    setup()
    // Daemon startup failed open and left this process's own provider serving, with nothing listed.
    const fallback = new LocalPtyProvider()
    loseWorkerTerminal(() =>
      listLocalProcessesForExitProofFromRuntimeController(
        { getLocalPtyProviderStartupPromise: () => Promise.resolve() },
        () => fallback
      )
    )
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(
        workerIncarnation,
        JSON.stringify({ kind: 'local', hostId: 'local' })
      )
    ).resolves.toBe('unverifiable')
  })

  it("reports the keep-open that landed while a stopped worker's exit proof was pending", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    // A stopped worker is retained as identity_unproven before its exit proof starts.
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    await call('orchestration.workerKeepOpen', { paneKey: workerPaneKey, keep: true })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_kept',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
  })

  it("reports a transfer that landed while a stopped worker's exit proof was pending", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()
    const resourceId = db.getWorkerTerminalResourceByOwner(dispatchId)!.id

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    // A follow-up worker takes the terminal over while the proof is pending.
    const { dispatch: successor } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: db.createTask({ spec: 'follow-up worker', runId: activeRunId }).id,
      startOptions: {}
    })
    db.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET owner_dispatch_id = ?, prior_owner_dispatch_ids = json_array(?) WHERE id = ?`
      )
      .run(successor.id, dispatchId, resourceId)
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      state: 'retained',
      reason: 'ownership_transferred',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResource(resourceId)).toMatchObject({
      owner_dispatch_id: successor.id,
      ownership_state: 'owned'
    })
    expect(db.getWorkerTerminalResource(resourceId)?.release_state).not.toBe('released')
  })

  describe("when daemon generations share the worker's PTY id", () => {
    function serveLocalDaemon(
      daemon: Pick<IPtyProvider, 'listProcesses'>,
      mayUnlistedDaemonOwnPtys?: () => Promise<boolean>
    ): void {
      loseWorkerTerminal(() =>
        listLocalProcessesForExitProofFromRuntimeController(
          { getLocalPtyProviderStartupPromise: () => undefined },
          () => daemon,
          PTY_CONTROLLER_LIST_TIMEOUT_MS,
          mayUnlistedDaemonOwnPtys
        )
      )
    }

    /** Older daemons as discovery leaves them in `runtimeDir`; the proof then asks about the rest. */
    async function discoverLegacyDaemons(runtimeDir: string): Promise<() => Promise<boolean>> {
      const adapters = await createLegacyDaemonAdapters(
        runtimeDir,
        path.join(runtimeDir, 'history')
      )
      const asked = new Set(adapters.map((adapter) => adapter.protocolVersion))
      return () => mayUnaskedDaemonRunSessions(runtimeDir, asked)
    }

    async function stoppedWorkerFromBeforeTheSweep(
      prepare?: (resourceId: string, dispatchId: string) => void
    ): Promise<string> {
      const { dispatchId } = await startSettledWorker()
      prepare?.(db.getWorkerTerminalResourceByOwner(dispatchId)!.id, dispatchId)
      db.db
        .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
        .run(dispatchId)
      // The sweep judges only rows written before its own (whole-second) start.
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET updated_at = datetime('now', '-1 minute') WHERE owner_dispatch_id = ?"
        )
        .run(dispatchId)
      goneAfterSettle()
      return dispatchId
    }

    it('lists the unrouted generation too, which the routed view leaves out', async () => {
      const daemon = twoGenerationDaemon(otherGeneration, workerGeneration)
      await expect(daemon.listProcesses()).resolves.toEqual([
        expect.objectContaining({ incarnationId: otherGeneration })
      ])
      await expect(
        listLocalProcessesForExitProofFromRuntimeController(
          { getLocalPtyProviderStartupPromise: () => undefined },
          () => daemon
        )
      ).resolves.toMatchObject({
        processes: [
          expect.objectContaining({ incarnationId: otherGeneration }),
          expect.objectContaining({ incarnationId: workerGeneration })
        ],
        inProcessOwner: false
      })
    })

    it('keeps a release pending while the worker lives on in an unrouted generation', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, workerGeneration))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).not.toBe('released')
      expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    })

    it('releases once neither generation lists the worker', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    })

    it('leaves a stopped worker owned in the sweep while an unrouted generation runs it', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, workerGeneration))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
    })

    it('sweeps a stopped worker neither generation lists', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    })

    it('keeps a release pending when discovery keeps a corrupt older-daemon record it cannot rule out', async () => {
      setup()
      const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-legacy-discovery-'))
      try {
        // A torn record and no socket: discovery adopts nothing, yet the record may name a live daemon.
        writeFileSync(path.join(runtimeDir, 'daemon-v5.pid'), '{"pid": 12')
        const guard = await discoverLegacyDaemons(runtimeDir)
        expect(existsSync(path.join(runtimeDir, 'daemon-v5.pid'))).toBe(true)
        serveLocalDaemon(twoGenerationDaemon(otherGeneration, otherGeneration), guard)
        const { dispatchId } = await startSettledWorker()
        goneAfterSettle()

        await expect(
          runtime.inspectTerminalProcessIncarnationLiveness(
            workerIncarnation,
            JSON.stringify({ kind: 'local', hostId: 'local' })
          )
        ).resolves.toBe('unverifiable')
        await expect(
          call('orchestration.workerRelease', { dispatch: dispatchId })
        ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
        expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('owned')
      } finally {
        rmSync(runtimeDir, { recursive: true, force: true })
      }
    })

    it('releases once discovery removes an older record whose daemon has exited', async () => {
      setup()
      const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-legacy-discovery-'))
      try {
        const exitedPid = spawnSync(process.execPath, ['-e', '']).pid
        writeFileSync(path.join(runtimeDir, 'daemon-v5.pid'), JSON.stringify({ pid: exitedPid }))
        const guard = await discoverLegacyDaemons(runtimeDir)
        expect(existsSync(path.join(runtimeDir, 'daemon-v5.pid'))).toBe(false)
        serveLocalDaemon(twoGenerationDaemon(otherGeneration, otherGeneration), guard)
        const { dispatchId } = await startSettledWorker()
        goneAfterSettle()

        await expect(
          call('orchestration.workerRelease', { dispatch: dispatchId })
        ).resolves.toMatchObject({ state: 'released' })
      } finally {
        rmSync(runtimeDir, { recursive: true, force: true })
      }
    })

    it('sweeps a stopped worker to its saved transcript, which released worker-read still reads', async () => {
      setup()
      // Two complete generations, no route, neither listing the worker: the absence is proven.
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, otherGeneration, false))
      let transcriptPath = ''
      const dispatchId = await stoppedWorkerFromBeforeTheSweep((resourceId) => {
        transcriptPath = saveSession(resourceId, `claude-swept-${resourceId}`)
      })
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'swept-1',
          timestamp: '2026-11-24T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'swept worker output' }] }
        })}\n`
      )
      try {
        await sweepStoppedWorkerTerminals(runtime, () => false)

        expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
          release_state: 'released',
          archive_source: 'transcript',
          archive_status: 'captured'
        })
        expect(JSON.parse(db.getWorkerTerminalArchive(dispatchId)!.content)).toMatchObject({
          agent: 'claude',
          transcriptPath
        })
        expect(
          JSON.stringify(await call('orchestration.workerRead', { dispatch: dispatchId }))
        ).toContain('swept worker output')
      } finally {
        rmSync(transcriptPath, { force: true })
      }
    })

    it('keeps the archive a stopped worker already had, byte for byte, when the sweep releases it', async () => {
      setup()
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, otherGeneration, false))
      const content = '{"version":3,"agent":"claude","sessionId":"kept-session"}'
      const dispatchId = await stoppedWorkerFromBeforeTheSweep((resourceId, owner) => {
        saveSession(resourceId, 'newer-session')
        db.storeWorkerTerminalArchiveBeforeStop({
          dispatchId: owner,
          resourceId,
          kind: 'transcript_pin',
          content,
          archiveSource: 'transcript',
          archiveStatus: 'captured'
        })
      })

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      expect(db.getWorkerTerminalArchive(dispatchId)?.content).toBe(content)
    })

    it('refuses when the daemon inventory is incomplete', async () => {
      setup()
      const resolver = new DaemonSessionOwnerResolver(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inventory listing reads only listProcesses.
        [
          {
            listProcesses: async () => {
              throw new Error('generation unreachable')
            }
          }
        ] as unknown as IPtyProvider[],
        new Map()
      )
      serveLocalDaemon({ listProcesses: (opts) => resolver.listProcesses(opts) })
      await expect(
        runtime.inspectTerminalProcessIncarnationLiveness(
          workerIncarnation,
          JSON.stringify({ kind: 'local', hostId: 'local' })
        )
      ).resolves.toBe('unverifiable')
    })

    it('keeps a release pending while a held newer daemon may still run the worker', async () => {
      setup()
      newerDaemonHold.held = true
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const { dispatchId } = await startSettledWorker()
      goneAfterSettle()

      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
      expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    })

    it('leaves a stopped worker owned in the sweep while a held newer daemon may run it', async () => {
      setup()
      newerDaemonHold.held = true
      serveLocalDaemon(twoGenerationDaemon(otherGeneration, '44444444-4444-4444-8444-444444444444'))
      const dispatchId = await stoppedWorkerFromBeforeTheSweep()

      await sweepStoppedWorkerTerminals(runtime, () => false)

      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
    })
  })

  it('lets one of two racing releases of a stopped worker settle it; the other reports already released', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
      .run(dispatchId)
    goneAfterSettle()

    const first = call('orchestration.workerRelease', { dispatch: dispatchId })
    const second = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(2))
    listing.resolve({ processes: [], inProcessOwner: false })

    const states = (await Promise.all([first, second])).map((receipt) =>
      typeof receipt === 'object' && receipt !== null && 'state' in receipt ? receipt.state : null
    )
    expect(states.toSorted()).toEqual(['already_released', 'released'])
    // The winner alone announces the transition.
    expect(
      vi
        .mocked(runtime.notifyMessageArrived)
        .mock.calls.filter(
          ([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status'
        )
    ).toHaveLength(1)
  })

  it('shares one proof between two joined releases of a finished worker; only one reports released', async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const first = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalledTimes(1))
    const second = call('orchestration.workerRelease', { dispatch: dispatchId })
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(first).resolves.toMatchObject({ state: 'released' })
    await expect(second).resolves.toMatchObject({ state: 'already_released' })
    expect(proving).toHaveBeenCalledTimes(1)
    expect(
      vi
        .mocked(runtime.notifyMessageArrived)
        .mock.calls.filter(
          ([target, kind]) => target === `dispatch:${dispatchId}` && kind === 'status'
        )
    ).toHaveLength(1)
  })

  /** The coordinator keeps the worker, then a new worker reuses its terminal: worker-start transfers it. */
  async function transferWhileProving(
    from: string
  ): Promise<{ taskId: string; dispatchId: string }> {
    await call('orchestration.workerRetain', { dispatch: from })
    const task = db.createTask({ spec: 'reuses the kept terminal', runId: activeRunId })
    // The terminal resolves again for the reuse, then is gone once more.
    fixture.terminalBack()
    const started: unknown = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      terminal: 'term_worker'
    })
    goneAfterSettle()
    if (!isStartReceipt(started)) {
      throw new Error('worker start returned no receipt')
    }
    expect(db.getWorkerTerminalResourceByOwner(started.dispatchId)).toBeDefined()
    return { taskId: task.id, dispatchId: started.dispatchId }
  }

  it("reports a requested release's transfer as ownership_transferred and leaves the new owner's row alone", async () => {
    setup()
    const listing = deferred<{ processes: never[]; inProcessOwner: boolean }>()
    const proving = vi.fn(() => listing.promise)
    loseWorkerTerminal(proving)
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proving).toHaveBeenCalled())
    const { dispatchId: successor } = await transferWhileProving(dispatchId)
    const before = db.getWorkerTerminalResourceByOwner(successor)
    listing.resolve({ processes: [], inProcessOwner: false })

    await expect(release).resolves.toMatchObject({
      dispatchId,
      state: 'retained',
      reason: 'ownership_transferred',
      archive: null
    })
    expect(db.getWorkerTerminalResourceByOwner(successor)).toEqual(before)
  })

  it("never hands a successor's release the predecessor's pending proof or receipt", async () => {
    setup()
    const proofs: ReturnType<
      typeof deferred<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>
    >[] = []
    loseWorkerTerminal(() => {
      proofs.push(deferred())
      return proofs.at(-1)!.promise
    })
    const { dispatchId } = await startSettledWorker()
    goneAfterSettle()

    const release = call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(proofs).toHaveLength(1))
    const { taskId, dispatchId: successor } = await transferWhileProving(dispatchId)
    db.settleWorkerReport({
      taskId,
      dispatchId: successor,
      outcome: 'succeeded',
      result: 'successor done'
    })
    const successorRelease = call('orchestration.workerRelease', { dispatch: successor })
    // Its own proof, not a join onto the predecessor's.
    await vi.waitFor(() => expect(proofs).toHaveLength(2))
    // The predecessor's proof answers first, and the worker is still alive.
    const alive = [{ id: 'pty-worker', incarnationId: workerGeneration, cwd: '', title: '' }]
    proofs[0]!.resolve({ processes: alive, inProcessOwner: false })
    await expect(release).resolves.toMatchObject({ dispatchId, reason: 'ownership_transferred' })
    expect(db.getWorkerTerminalResourceByOwner(successor)?.release_state).toBe('requested')

    proofs[1]!.resolve({ processes: [], inProcessOwner: false })
    await expect(successorRelease).resolves.toMatchObject({
      dispatchId: successor,
      state: 'released'
    })
  })

  it('never lets a former owner release the resource its successor now holds', async () => {
    setup()
    loseWorkerTerminal(async () => ({ processes: [], inProcessOwner: false }))
    const { dispatchId } = await startSettledWorker()
    const { taskId, dispatchId: successor } = await transferWhileProving(dispatchId)
    db.settleWorkerReport({
      taskId,
      dispatchId: successor,
      outcome: 'succeeded',
      result: 'successor done'
    })
    const resourceId = db.getWorkerTerminalResourceByOwner(successor)!.id
    // The successor holds a matching archive, and its exact process is proven gone.
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId: successor,
      resourceId,
      kind: 'terminal_tail',
      content: '{"version":3,"fallbackReason":"session_not_reported"}',
      archiveSource: 'terminal',
      archiveStatus: 'unavailable'
    })
    goneAfterSettle()
    const before = db.getWorkerTerminalResource(resourceId)
    const archive = db.getWorkerTerminalArchive(successor)

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'ownership_transferred' })
    expect(db.getWorkerTerminalResource(resourceId)).toEqual(before)
    expect(db.getWorkerTerminalArchive(successor)).toEqual(archive)
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalledWith(
      `dispatch:${dispatchId}`,
      'status'
    )
  })
})
