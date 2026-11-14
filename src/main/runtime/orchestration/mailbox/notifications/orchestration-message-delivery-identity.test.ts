import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'

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

type MessageResult = { id: string; type: string; read: number }
type CheckResult = {
  runId: string
  deliveryId: string | null
  messages: MessageResult[]
  count: number
  replayed?: boolean
  acknowledged?: string | null
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
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
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
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
  // Await the model's write chain so the chunk is parsed.
  await runtime.serializeMainTerminalBuffer(PTY_ID)
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

describe('STA-4325 message and delivery identity', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
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
})
