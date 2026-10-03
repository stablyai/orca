import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { runProcess, spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { WorkerReportOutbox } from '../../shared/worker-report-outbox'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { OrchestrationDb } from './orchestration/db'
import { drainWorkerReports } from '../../shared/worker-report-recovery'
import { replayWorkerReport } from './worker-report-replay'
import { writeWorkerReportFile } from '../../shared/worker-report-storage'

const cleanups: (() => Promise<void>)[] = []
class ReportTestServer extends OrcaRuntimeRpcServer {
  override handleMessage(...args: Parameters<OrcaRuntimeRpcServer['handleMessage']>) {
    return super.handleMessage(...args)
  }
}
const cliBuild = mkdtempSync(join(tmpdir(), 'orca-report-cli-'))
const cliEntry = join(cliBuild, 'cli.cjs')
beforeAll(async () => {
  await build({
    entryPoints: [resolve('src/cli/index.ts')],
    outfile: cliEntry,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(cliBuild, { recursive: true, force: true }))
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-report-integration-'))
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'orchestration.db')
  const db = new OrchestrationDb(path)
  let databaseClosed = false
  const closeDatabase = () => {
    if (!databaseClosed) {
      db.close()
      databaseClosed = true
    }
  }
  const run = db.createRun({
    objective: 'recover worker completion',
    coordinatorHandle: 'term-coordinator',
    coordinatorPaneKey: 'tab:coordinator'
  })
  const task = db.createTask({ runId: run.id, spec: 'Finish while disconnected' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term-worker',
    paneKey: 'tab:worker',
    processIncarnation: 'pty-original',
    worktreeId: 'folder:worker',
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  const capability = db.mintDispatchCapability({
    dispatchId: dispatch.id,
    paneKey: 'tab:worker',
    processIncarnation: 'pty-original'
  })
  const params = {
    from: 'term-worker',
    type: 'worker_done',
    subject: 'Finished',
    body: 'Implemented. Verified. Nothing left.',
    payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' }),
    waitForLifecycleSettlement: true
  }
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab:worker')
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('pty-original')
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const server = new ReportTestServer({ runtime, userDataPath: root })
  cleanups.push(async () => {
    await server.stop()
    closeDatabase()
  })
  return {
    root,
    path,
    db,
    closeDatabase,
    task,
    dispatch,
    capability,
    params,
    runtime,
    server,
    store: new WorkerReportOutbox(root)
  }
}

async function restart(fixture: ReturnType<typeof setup>, identityAvailable = true) {
  await fixture.server.stop()
  fixture.closeDatabase()
  const db = new OrchestrationDb(fixture.path)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const original = db.getDispatchContextById(fixture.dispatch.id)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
    identityAvailable ? (original?.assignee_pane_key ?? null) : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
    identityAvailable ? (original?.process_incarnation ?? null) : null
  )
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const server = new ReportTestServer({ runtime, userDataPath: fixture.root })
  cleanups.push(async () => {
    await server.stop()
    db.close()
  })
  await server.start()
  return { db, server }
}

function reportCommand(f: ReturnType<typeof setup>): ProcessSpec {
  return {
    program: process.execPath,
    args: [
      cliEntry,
      'orchestration',
      'send',
      '--from',
      'term-worker',
      '--dispatch-capability',
      f.capability,
      '--type',
      'worker_done',
      '--subject',
      'Finished',
      '--body',
      'Implemented. Verified. Nothing left.',
      '--task-id',
      f.task.id,
      '--dispatch-id',
      f.dispatch.id,
      '--outcome',
      'succeeded',
      '--json'
    ],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: f.root,
      ORCA_ENVIRONMENT: '',
      ORCA_PAIRING_CODE: '',
      ORCA_REMOTE_PAIRING: '',
      NODE_PATH: resolve('node_modules')
    },
    timeoutMs: 10_000
  }
}

async function expectPendingCli(f: ReturnType<typeof setup>): Promise<void> {
  const result = await runProcess(reportCommand(f))
  expect(result.code, result.stderr).toBe(1)
  expect(result.stdout).toContain('worker_report_pending')
}

async function makeReportsDue(f: ReturnType<typeof setup>): Promise<void> {
  // Change only isolated retry scheduling; wall-clock mocking breaks filesystem lock leases.
  for (const record of await f.store.pending()) {
    const filename = `${createHash('sha256').update(record.input.requestId).digest('hex')}.json`
    await writeWorkerReportFile(join(f.store.directory, filename), { ...record, nextAttemptAt: 0 })
  }
}

describe('worker report CLI and isolated runtime recovery', () => {
  it('waits through missing startup identity and resumes when the original identity returns', async () => {
    const f = setup()
    await expectPendingCli(f)
    await makeReportsDue(f)
    vi.mocked(f.runtime.getTerminalPaneKey).mockReturnValue(null)
    vi.mocked(f.runtime.getTerminalProcessIncarnation).mockReturnValue(null)
    await f.server.start()
    await f.server['workerReportRecovery']?.drain()
    expect((await f.store.pending()).length).toBe(1)
    expect(f.db.getTask(f.task.id)?.status).not.toBe('completed')
    const original = f.db.getDispatchContextById(f.dispatch.id)
    vi.mocked(f.runtime.getTerminalPaneKey).mockReturnValue(original?.assignee_pane_key ?? null)
    vi.mocked(f.runtime.getTerminalProcessIncarnation).mockReturnValue(
      original?.process_incarnation ?? null
    )
    await f.server['workerReportRecovery']?.stop()
    await makeReportsDue(f)
    f.server['workerReportRecovery']?.start()
    await f.server['workerReportRecovery']?.drain()
    expect((await f.store.pending()).length).toBe(0)
    expect(f.db.getTask(f.task.id)?.status).toBe('completed')
  })
  it.each(['before-send', 'after-accept'] as const)(
    'survives SIGKILL of the real CLI at %s and drains on runtime restart',
    async (boundary) => {
      const f = setup()
      await f.server.start()
      const original = f.server['handleMessage'].bind(f.server)
      let terminate = () => undefined
      vi.spyOn(f.server, 'handleMessage').mockImplementation(async (text, context) => {
        const method = JSON.parse(text).method
        if (boundary === 'before-send' && method === 'status.get') {
          terminate()
          throw new Error('injected CLI crash before send')
        }
        const response = await original(text, context)
        if (boundary === 'after-accept' && method === 'orchestration.send') {
          terminate()
          throw new Error('injected CLI crash after durable acceptance')
        }
        return response
      })
      const child = spawnProcess(reportCommand(f))
      child.stdin.end()
      child.stdout.resume()
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      terminate = () => {
        child.kill('SIGKILL')
        return undefined
      }
      const closed = new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', () => resolve())
      })
      cleanups.push(async () => {
        child.kill('SIGKILL')
        await closed
      })
      await closed
      const records = await f.store.pending()
      expect(records, stderr).toHaveLength(1)
      expect(f.db.getTask(f.task.id)?.status === 'completed').toBe(boundary === 'after-accept')
      await f.server.stop()
      await makeReportsDue(f)
      const recovered = await restart(f, boundary !== 'after-accept')
      await vi.waitFor(async () => expect(await f.store.pending()).toEqual([]))
      expect(recovered.db.getTask(f.task.id)?.status).toBe('completed')
      expect(
        recovered.db.getInbox(100).filter((message) => message.type === 'worker_done')
      ).toHaveLength(1)
    }
  )

  it('saves before first connection and automatically settles after runtime startup without a sender', async () => {
    const f = setup()
    await expectPendingCli(f)
    const [saved] = await f.store.pending()
    expect(saved?.input.params).toMatchObject(f.params)
    expect(f.db.getTask(f.task.id)?.status).not.toBe('completed')
    // Advance persisted retry eligibility without retaining the original CLI object.
    await makeReportsDue(f)
    const recovered = await restart(f)
    await vi.waitFor(() => expect(recovered.db.getTask(f.task.id)?.status).toBe('completed'))
    await vi.waitFor(async () => expect(await f.store.pending()).toEqual([]))
    expect(recovered.db.getDispatchContextById(f.dispatch.id)?.status).toBe('completed')
    expect(recovered.db.getWorkerDispatch(f.dispatch.id)?.state).toBe('succeeded')
    expect(
      recovered.db
        .listWorkerTerminalResources({ runId: f.task.run_id })
        .find((row) => row.dispatchId === f.dispatch.id)?.terminalState
    ).toBe('reclaimable')
    expect(
      recovered.db.getInbox(100).filter((message) => message.type === 'worker_done')
    ).toHaveLength(1)
  })

  it('replays a committed report after response loss and another replay interruption without duplicate effects', async () => {
    const f = setup()
    await f.server.start()
    const original = f.server['handleMessage'].bind(f.server)
    vi.spyOn(f.server, 'handleMessage').mockImplementation(async (text, context) => {
      const response = await original(text, context)
      if (JSON.parse(text).method === 'orchestration.send') {
        throw new Error('injected response loss')
      }
      return response
    })
    await expectPendingCli(f)
    expect(f.db.getTask(f.task.id)?.status).toBe('completed')
    await f.server.stop()
    await makeReportsDue(f)
    await drainWorkerReports(f.store, async () => {
      throw new Error('crash during replay')
    })
    await makeReportsDue(f)
    const recovered = await restart(f)
    await vi.waitFor(async () => expect(await f.store.pending()).toEqual([]))
    expect(
      recovered.db.getInbox(100).filter((message) => message.type === 'worker_done')
    ).toHaveLength(1)
    expect(recovered.db.getDispatchContextById(f.dispatch.id)?.status).toBe('completed')
  })

  it('does not settle a revoked Dispatch or substitute the currently active worker identity', async () => {
    const f = setup()
    await expectPendingCli(f)
    f.db.revokeDispatchCapability(f.dispatch.id)
    await makeReportsDue(f)
    const recovered = await restart(f)
    await vi.waitFor(async () => expect(await f.store.pending()).toEqual([]))
    expect(recovered.db.getTask(f.task.id)?.status).not.toBe('completed')
    expect(recovered.db.getDispatchContextById(f.dispatch.id)?.status).not.toBe('completed')
  })

  it('keeps a pinned remote target out of the local dispatch path', async () => {
    const f = setup()
    await expectPendingCli(f)
    const [saved] = await f.store.pending()
    if (!saved) {
      throw new Error('Missing durable report')
    }
    const local = vi.fn()
    const remote = {
      ...saved.input,
      pairing: {
        v: 2 as const,
        endpoint: 'ws://127.0.0.1:1',
        deviceToken: 'original-device',
        publicKeyB64: Buffer.alloc(32).toString('base64'),
        scope: 'runtime' as const
      }
    }
    await expect(replayWorkerReport(remote, local, 'local-token')).rejects.toThrow()
    expect(local).not.toHaveBeenCalled()
  })
})
