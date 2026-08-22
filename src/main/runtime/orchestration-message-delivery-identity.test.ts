import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-sta-4325'
const TERMINAL_HANDLE = 'term_sta_4325'
const REMINTED_TERMINAL_HANDLE = 'term_sta_4325_reminted'
const WORKTREE_ID = 'repo-sta-4325::/tmp/sta-4325'
const LAUNCH_TOKEN = 'sta-4325-launch'
const temporaryDirectories: string[] = []
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')
const itIfCliBuilt = existsSync(CLI_PATH) ? it : it.skip

type MessageResult = { id: string; type: string; read: number }
type CheckResult = {
  runId: string
  deliveryId: string | null
  messages: MessageResult[]
  count: number
  replayed?: boolean
  acknowledged?: string | null
}

type Sqlite = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
  }
}

function sqliteFor(db: OrchestrationDb): Sqlite {
  return (db as unknown as { db: Sqlite }).db
}

function createDatabase(prefix: string): { db: OrchestrationDb; path: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  const path = join(directory, 'orchestration.db')
  return { db: new OrchestrationDb(path), path }
}

function createRuntime(
  db: OrchestrationDb,
  terminalHandle = TERMINAL_HANDLE
): {
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService(null, undefined, {
    attestAgentHookCompatibilityAuthority: ({ paneKey }) =>
      paneKey === PANE_KEY ? { paneKey, source: 'current_hook' } : null
  })
  const write = vi.fn(() => true)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({ write, kill: vi.fn(), getForegroundProcess: async () => null })
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'sta-4325-incarnation',
    agentLaunchAuthority: { launchToken: LAUNCH_TOKEN, launchAgent: 'codex' }
  })
  runtime.registerPreAllocatedHandleForPty(PTY_ID, terminalHandle)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID
      }
    ]
  })
  return { runtime, write }
}

async function driveToLiveIdle(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.listTerminals()
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
  await Promise.resolve()
}

async function check(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown> = {}
): Promise<CheckResult> {
  const terminal = typeof params.terminal === 'string' ? params.terminal : TERMINAL_HANDLE
  const response = await new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch({
    id: `req-sta-4325-${Math.random()}`,
    authToken: 'test-auth-token',
    method: 'orchestration.check',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationCompatibilityEvidence: {
      terminalHandle: terminal,
      paneKey: PANE_KEY,
      launchToken: LAUNCH_TOKEN
    },
    params: { terminal, ...params }
  })
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as CheckResult
}

function pointerPayloads(write: ReturnType<typeof vi.fn>): string[] {
  return write.mock.calls
    .map(([, payload]) => String(payload))
    .filter((payload) => payload.includes('orca orchestration check'))
}

async function runBuiltCli(
  userDataPath: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_TERMINAL_HANDLE: TERMINAL_HANDLE,
      ORCA_PANE_KEY: PANE_KEY
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('close', (code) => resolve(code ?? 1))
    child.once('error', reject)
  })
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('STA-4325 message and delivery identity', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps pointer counts, filters, message IDs, and one fixed Delivery aligned through ack', async () => {
    vi.useFakeTimers()
    const { db } = createDatabase('orca-sta-4325-identity-')
    const { runtime, write } = createRuntime(db)
    const run = db.createRun({
      objective: 'STA-4325 identity',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const status = db.insertMessage({
      from: 'term_worker_a',
      to: TERMINAL_HANDLE,
      subject: 'stale status',
      type: 'status',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    const dispatch = db.insertMessage({
      from: 'term_worker_b',
      to: `run:${run.id}`,
      subject: 'dispatch receipt',
      type: 'dispatch',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    const done = db.insertMessage({
      from: 'term_worker_c',
      to: TERMINAL_HANDLE,
      subject: 'worker complete',
      type: 'worker_done',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    await driveToLiveIdle(runtime)
    const [first, concurrent] = await Promise.all([check(runtime), check(runtime)])
    const expectedIds = [status.id, dispatch.id, done.id]

    expect(pointerPayloads(write)).toEqual([expect.stringContaining('3 orchestration messages')])
    expect(first).toMatchObject({ runId: run.id, count: 3, replayed: false })
    expect(concurrent).toMatchObject({ runId: run.id, count: 3, replayed: true })
    expect(first.deliveryId).toBeTruthy()
    expect(concurrent.deliveryId).toBe(first.deliveryId)
    expect(first.messages.map((message) => message.id)).toEqual(expectedIds)
    expect(concurrent.messages.map((message) => message.id)).toEqual(expectedIds)

    const peeked = await check(runtime, { peek: true, unread: false })
    const filtered = await check(runtime, { peek: true, unread: false, types: 'worker_done' })
    const all = await check(runtime, { all: true })
    expect(peeked.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(expectedIds)
    )
    expect(peeked.count).toBe(3)
    expect(filtered.messages.map((message) => message.id)).toEqual([done.id])
    expect(all.messages.map((message) => message.id)).toEqual(expect.arrayContaining(expectedIds))
    expect(all.count).toBe(3)

    const deliveryRowsBeforeAck = sqliteFor(db)
      .prepare('SELECT id, status, message_ids FROM deliveries ORDER BY rowid')
      .all() as { id: string; status: string; message_ids: string }[]
    expect(deliveryRowsBeforeAck).toEqual([
      { id: first.deliveryId, status: 'outstanding', message_ids: JSON.stringify(expectedIds) }
    ])
    for (const id of expectedIds) {
      expect(db.getMessageById(id)).toMatchObject({ to_handle: `run:${run.id}`, read: 0 })
    }

    const acknowledged = await check(runtime, { ack: first.deliveryId })
    expect(acknowledged).toMatchObject({
      count: 0,
      deliveryId: null,
      acknowledged: first.deliveryId
    })
    expect((await check(runtime, { unread: true })).count).toBe(0)
    const acknowledgedHistory = await check(runtime, { all: true })
    expect(acknowledgedHistory.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(expectedIds)
    )
    expect(acknowledgedHistory.count).toBe(3)
    expect(sqliteFor(db).prepare('SELECT id, status FROM deliveries ORDER BY rowid').all()).toEqual(
      [{ id: first.deliveryId, status: 'acknowledged' }]
    )
    for (const id of expectedIds) {
      expect(db.getMessageById(id)?.read).toBe(1)
    }
    db.close()
  })

  it('replays one outstanding Delivery across restart and wakes a filtered waiter once', async () => {
    vi.useFakeTimers()
    const fixture = createDatabase('orca-sta-4325-restart-')
    const firstRuntime = createRuntime(fixture.db)
    const run = fixture.db.createRun({
      objective: 'STA-4325 restart',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const status = fixture.db.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'survive restart',
      type: 'status',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    await driveToLiveIdle(firstRuntime.runtime)
    const beforeRestart = await check(firstRuntime.runtime)
    expect(beforeRestart.messages.map((message) => message.id)).toEqual([status.id])
    fixture.db.close()

    const reopened = new OrchestrationDb(fixture.path)
    const restarted = createRuntime(reopened, REMINTED_TERMINAL_HANDLE)
    await driveToLiveIdle(restarted.runtime)
    const afterRestart = await check(restarted.runtime, { terminal: REMINTED_TERMINAL_HANDLE })
    expect(afterRestart).toMatchObject({ deliveryId: beforeRestart.deliveryId, replayed: true })
    expect(afterRestart.messages.map((message) => message.id)).toEqual([status.id])
    expect(sqliteFor(reopened).prepare('SELECT id FROM deliveries').all()).toEqual([
      { id: beforeRestart.deliveryId }
    ])

    await check(restarted.runtime, {
      terminal: REMINTED_TERMINAL_HANDLE,
      ack: afterRestart.deliveryId
    })
    const waiting = check(restarted.runtime, {
      terminal: REMINTED_TERMINAL_HANDLE,
      wait: true,
      types: 'worker_done',
      timeoutMs: 5_000
    })
    const internals = restarted.runtime as unknown as {
      messageWaitersByHandle: Map<string, Set<unknown>>
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (internals.messageWaitersByHandle.has(`run:${run.id}`)) {
        break
      }
      await Promise.resolve()
    }
    expect(internals.messageWaitersByHandle.has(`run:${run.id}`)).toBe(true)

    const done = reopened.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'done after restart',
      type: 'worker_done',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    restarted.runtime.notifyMessageArrived(done.to_handle, done.type)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toMatchObject({
      runId: run.id,
      count: 1,
      messages: [expect.objectContaining({ id: done.id })]
    })
    expect(pointerPayloads(restarted.write)).toHaveLength(0)
    reopened.close()
  })

  it('routes the complete direct backlog before rebinding forgets its old handle', () => {
    const fixture = createDatabase('orca-sta-4325-rebind-backlog-')
    const first = fixture.db.createRun({
      objective: 'Old coordinator',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    for (let index = 0; index < 125; index += 1) {
      const message = fixture.db.insertMessage({
        from: 'term_worker',
        to: TERMINAL_HANDLE,
        subject: `backlog ${index}`,
        type: 'status',
        runId: first.id,
        deliveryContract: 'current_delivery'
      })
      sqliteFor(fixture.db)
        .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
        .run(TERMINAL_HANDLE, message.id)
    }
    const plan = sqliteFor(fixture.db)
      .prepare(
        `EXPLAIN QUERY PLAN UPDATE messages SET to_handle = ?
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'`
      )
      .all(`run:${first.id}`, first.id, TERMINAL_HANDLE) as { detail: string }[]
    expect(plan.map((row) => row.detail).join(' ')).toMatch(
      /SEARCH messages USING INDEX (idx_messages_delivery_contract|idx_messages_unread_current_inbox)/
    )
    fixture.db.createRun({
      objective: 'Replacement coordinator',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    expect(fixture.db.getRun(first.id)?.coordinator_handle).toBeNull()
    fixture.db.close()

    const reopened = new OrchestrationDb(fixture.path)
    expect(
      sqliteFor(reopened)
        .prepare(
          `SELECT to_handle, COUNT(*) AS count FROM messages
           WHERE run_id = ? GROUP BY to_handle ORDER BY to_handle`
        )
        .all(first.id)
    ).toEqual([{ to_handle: `run:${first.id}`, count: 125 }])
    reopened.close()
  })

  it('repairs committed mail sent to a forgotten handle after restart', async () => {
    const fixture = createDatabase('orca-sta-4325-late-old-handle-')
    const run = fixture.db.createRun({
      objective: 'Late old-handle arrival',
      coordinatorHandle: TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    fixture.db.bindRun({
      runId: run.id,
      coordinatorHandle: REMINTED_TERMINAL_HANDLE,
      coordinatorPaneKey: PANE_KEY
    })
    const done = fixture.db.insertMessage({
      from: 'term_worker',
      to: TERMINAL_HANDLE,
      subject: 'arrived after rebind',
      type: 'worker_done',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    expect(fixture.db.getMessageById(done.id)?.to_handle).toBe(`run:${run.id}`)
    expect(
      fixture.db
        .getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: fixture.db.getRun(run.id)!.consumer_generation
        })
        ?.messages.map((message) => message.id)
    ).toEqual([done.id])
    fixture.db.close()

    const reopened = new OrchestrationDb(fixture.path)
    const restarted = createRuntime(reopened, REMINTED_TERMINAL_HANDLE)
    await driveToLiveIdle(restarted.runtime)
    const checked = await check(restarted.runtime, { terminal: REMINTED_TERMINAL_HANDLE })

    expect(checked).toMatchObject({
      runId: run.id,
      count: 1,
      messages: [expect.objectContaining({ id: done.id })]
    })
    expect(reopened.getMessageById(done.id)?.to_handle).toBe(`run:${run.id}`)
    reopened.close()
  })

  itIfCliBuilt(
    'keeps the built CLI count and Delivery output aligned with isolated SQLite state',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sta-4325-cli-'))
      temporaryDirectories.push(userDataPath)
      const db = new OrchestrationDb(join(userDataPath, 'orchestration.db'))
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === TERMINAL_HANDLE ? PANE_KEY : null
      )
      const run = db.createRun({
        objective: 'STA-4325 built CLI',
        coordinatorHandle: TERMINAL_HANDLE,
        coordinatorPaneKey: PANE_KEY
      })
      const status = db.insertMessage({
        from: 'term_worker',
        to: TERMINAL_HANDLE,
        subject: 'direct status',
        type: 'status',
        runId: run.id,
        deliveryContract: 'current_delivery'
      })
      const done = db.insertMessage({
        from: 'term_worker',
        to: `run:${run.id}`,
        subject: 'canonical done',
        type: 'worker_done',
        runId: run.id,
        deliveryContract: 'current_delivery'
      })
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
      await server.start()

      try {
        const first = await runBuiltCli(userDataPath, ['orchestration', 'check', '--json'])
        expect(first.exitCode, first.stderr).toBe(0)
        const firstPayload = JSON.parse(first.stdout) as { result: CheckResult }
        expect(firstPayload.result).toMatchObject({ runId: run.id, count: 2, replayed: false })
        expect(firstPayload.result.messages.map((message) => message.id)).toEqual([
          status.id,
          done.id
        ])

        const replay = await runBuiltCli(userDataPath, ['orchestration', 'check', '--json'])
        expect(replay.exitCode, replay.stderr).toBe(0)
        const replayPayload = JSON.parse(replay.stdout) as { result: CheckResult }
        expect(replayPayload.result).toMatchObject({
          count: 2,
          deliveryId: firstPayload.result.deliveryId,
          replayed: true
        })
        expect(sqliteFor(db).prepare('SELECT id, status FROM deliveries').all()).toEqual([
          { id: firstPayload.result.deliveryId, status: 'outstanding' }
        ])
        expect(db.getMessageById(status.id)).toMatchObject({
          to_handle: `run:${run.id}`,
          read: 0
        })

        const acknowledged = await runBuiltCli(userDataPath, [
          'orchestration',
          'check',
          '--ack',
          firstPayload.result.deliveryId!,
          '--json'
        ])
        expect(acknowledged.exitCode, acknowledged.stderr).toBe(0)
        expect(JSON.parse(acknowledged.stdout)).toMatchObject({
          result: { count: 0, deliveryId: null, acknowledged: firstPayload.result.deliveryId }
        })
        expect(db.getMessageById(status.id)?.read).toBe(1)
        expect(db.getMessageById(done.id)?.read).toBe(1)
      } finally {
        await server.stop()
        db.close()
      }
    },
    30_000
  )
})
