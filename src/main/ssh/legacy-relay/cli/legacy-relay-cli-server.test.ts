import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import '../../../../shared/ssh-remote-cli-control'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { OrchestrationDb } from '../../../runtime/orchestration/db/orchestration-db'
import '../../../runtime/orchestration/db/contract-constants'
import '../../../runtime/orchestration/db/messages/mailbox-routing-page'
import '../../../runtime/orchestration/db/dispatch-row-writer'
import '../../../runtime/orchestration/db/attempt-outcome-projection'
import { LEGACY_RELAY_CLI_UNVERIFIED } from './legacy-relay-cli-caller'
import { createLegacyRelayCliServer, LEGACY_RELAY_CLI_CONTROL_OFF } from './legacy-relay-cli-server'
import type { LegacyRelayLivePane } from '../bridge/legacy-relay-bridge-leases'

const TARGET = 'target-1'
const WORKER = 'term_relay_worker'
const WORKER_PANE = 'tab_w:33333333-3333-4333-8333-333333333333'
const COORDINATOR = 'term_local_coord'
const COORDINATOR_PANE = 'tab_c:44444444-4444-4444-8444-444444444444'
const PTY_ID = toAppSshPtyId(TARGET, 'pty-7')
const ENV = { ORCA_TERMINAL_HANDLE: WORKER, ORCA_PANE_KEY: WORKER_PANE }

type Result = { stdout: string; stderr: string; exitCode: number }

let dir: string
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let allowed: boolean
let panes: Map<string, LegacyRelayLivePane>
let ids: { runId: string; taskId: string; dispatchId: string }

function server() {
  return createLegacyRelayCliServer({
    targetId: TARGET,
    runtime: () => runtime,
    remoteCliControl: () => allowed,
    livePane: (paneKey) => panes.get(paneKey) ?? null
  })
}

async function run(
  argv: string[],
  env: Record<string, string> = ENV,
  signal = new AbortController().signal
): Promise<Result> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI server always resolves this shape.
  return (await server().cli({ argv, env, cwd: '/' }, signal)) as Result
}

function json(result: Result): { ok: boolean; result?: Record<string, unknown> } {
  return JSON.parse(result.stdout)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-legacy-relay-cli-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  allowed = true
  const orchestrationRun = db.createRun({
    objective: 'retained work',
    coordinatorHandle: COORDINATOR,
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const task = db.createTask({
    runId: orchestrationRun.id,
    spec: 'finish it',
    createdByTerminalHandle: COORDINATOR
  })
  // The relay era recorded the worker's process as its SSH PTY id and relay incarnation.
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: WORKER,
    assigneePaneKey: WORKER_PANE,
    processIncarnation: `${PTY_ID}:inc-1`,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  ids = { runId: orchestrationRun.id, taskId: task.id, dispatchId: dispatch.id }
  panes = new Map([
    [WORKER_PANE, { ptyId: PTY_ID, incarnationId: 'inc-1', terminalHandle: WORKER }]
  ])
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const workerDone = () => [
  'orchestration',
  'send',
  '--type',
  'worker_done',
  '--subject',
  'done',
  '--task-id',
  ids.taskId,
  '--dispatch-id',
  ids.dispatchId,
  '--outcome',
  'succeeded',
  '--json'
]

describe('the relay-era orca CLI on the desktop runtime', () => {
  it("serves a retained worker's inbox check and worker_done as that worker", async () => {
    const mail = db.insertMessage({
      runId: ids.runId,
      from: COORDINATOR,
      to: `dispatch:${ids.dispatchId}`,
      subject: 'guidance',
      deliveryContract: 'current_delivery'
    })

    const check = await run(['orchestration', 'check', '--json'])
    expect(check.exitCode).toBe(0)
    expect(json(check).result).toMatchObject({
      dispatchId: ids.dispatchId,
      messages: [{ id: mail.id }]
    })

    const done = await run(workerDone())
    expect(json(done)).toMatchObject({ ok: true })
    expect(json(done).result).not.toHaveProperty('lifecycle.action', 'rejected')
    expect(done.exitCode).toBe(0)
    expect(db.getTask(ids.taskId)?.status).toBe('completed')
    expect(runtime.getTerminalProcessIncarnation(WORKER)).toBeNull()
    expect(runtime.getTerminalPaneKey(WORKER)).toBeNull()
  })

  it('refuses every command while the per-host switch is off', async () => {
    allowed = false
    await expect(run(workerDone())).rejects.toThrow(LEGACY_RELAY_CLI_CONTROL_OFF)
    expect(db.getTask(ids.taskId)?.status).toBe('dispatched')
  })

  it.each([
    ['a pane the bridge does not run', () => panes.clear(), ENV],
    [
      'a handle the relay did not launch the pane with',
      () => panes.set(WORKER_PANE, { ptyId: PTY_ID, terminalHandle: 'term_other' }),
      ENV
    ],
    ['no pane key', () => {}, { ORCA_TERMINAL_HANDLE: WORKER }],
    [
      'a handle the desktop records do not bind to the pane',
      () => {},
      { ORCA_TERMINAL_HANDLE: COORDINATOR, ORCA_PANE_KEY: WORKER_PANE }
    ],
    [
      'a handle this runtime hosts in another pane',
      () => vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(COORDINATOR_PANE),
      ENV
    ]
  ])('refuses %s', async (_case, arrange, env) => {
    arrange()
    await expect(run(workerDone(), env)).rejects.toThrow(LEGACY_RELAY_CLI_UNVERIFIED)
    expect(db.getTask(ids.taskId)?.status).toBe('dispatched')
  })

  it('keeps a retained worker inside its own orchestration', async () => {
    const coordinatorMail = db.insertMessage({
      runId: ids.runId,
      from: WORKER,
      to: COORDINATOR,
      subject: 'not yours',
      deliveryContract: 'current_delivery'
    })
    const otherTask = db.createTask({
      runId: ids.runId,
      spec: 'other',
      createdByTerminalHandle: COORDINATOR
    })
    const other = db.createDispatchContext({
      taskId: otherTask.id,
      assigneeHandle: 'term_local_worker',
      assigneePaneKey: 'tab_x:55555555-5555-4555-8555-555555555555',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const refusals: string[][] = [
      ['orchestration', 'check', '--terminal', COORDINATOR],
      ['orchestration', 'inbox', '--terminal', COORDINATOR],
      ['orchestration', 'send', '--from', COORDINATOR, '--to', WORKER, '--subject', 's'],
      ['orchestration', 'send', '--to', 'term_local_worker', '--subject', 's'],
      ['orchestration', 'send', '--to', `dispatch:${other.id}`, '--subject', 's'],
      ['orchestration', 'send', '--to', '@all', '--subject', 's'],
      [
        'orchestration',
        'send',
        '--subject',
        's',
        '--dispatch-id',
        other.id,
        '--task-id',
        otherTask.id
      ],
      ['orchestration', 'check', '--run', 'run_someone_else'],
      ['orchestration', 'reply', '--id', coordinatorMail.id, '--body', 'b'],
      ['orchestration', 'ask', '--to', 'term_local_worker', '--question', 'q']
    ]
    for (const argv of refusals) {
      await expect(run(argv), argv.join(' ')).rejects.toThrow(/outside it/)
    }
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('replays a completed worker_done after its Dispatch settled, and nothing new', async () => {
    const retry = ['--retry-request', '11111111-1111-4111-8111-111111111111']
    const first = await run([...workerDone(), ...retry])
    expect(db.getTask(ids.taskId)?.status).toBe('completed')
    const replay = await run([...workerDone(), ...retry])
    expect(json(replay)).toMatchObject({ ok: true })
    expect(json(replay).result?.message).toEqual(json(first).result?.message)
    await expect(
      run([...workerDone(), '--retry-request', '22222222-2222-4222-8222-222222222222'])
    ).rejects.toThrow(LEGACY_RELAY_CLI_UNVERIFIED)
  })

  it("never lets a completed retry id unlock another caller's mailbox", async () => {
    const retry = ['--retry-request', '55555555-5555-4555-8555-555555555555']
    await run(['orchestration', 'send', '--to', COORDINATOR, '--subject', 'hi', ...retry])
    await expect(
      run(['orchestration', 'inbox', '--terminal', `run:${ids.runId}`, ...retry])
    ).rejects.toThrow(/outside it/)
    await expect(
      run(['orchestration', 'check', '--terminal', COORDINATOR, ...retry])
    ).rejects.toThrow(/outside it/)
  })
})
