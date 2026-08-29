// `worker-show` must distinguish a worker parked on a human prompt (STA-3714, STA-4513).
// Deliberately unmocked below the RPC so detector, plumbing, and RPC shape are all covered.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-worker'
const WORKTREE_ID = 'wt-worker'
const PTY_ID = 'pty-worker'

// Captured verbatim from cursor-agent 2026.08.11-e8db854 driven through Orca.
function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../__fixtures__', `${name}.txt`), 'utf8')
}

function workerShowMethod() {
  const method = ORCHESTRATION_METHODS.find(
    (candidate) => candidate.name === 'orchestration.workerShow'
  )
  if (!method) {
    throw new Error('Missing method orchestration.workerShow')
  }
  return method
}

describe('worker-show interactive wait (STA-3714, STA-4513)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  async function showWorkerPaneServing(paneOutput: string, opts?: { breakIdentity?: boolean }) {
    const runtime = new OrcaRuntimeService(null)
    const internals = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    }
    vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: WORKTREE_ID,
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'inc-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'worker'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'worker',
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
          ptyId: PTY_ID,
          // cursor-agent's spinner title, identical whether it runs or waits.
          paneTitle: '⠇ Cursor Agent'
        }
      ]
    })
    runtime.onPtyData(PTY_ID, paneOutput, Date.now())

    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'supervise lanes',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'run the suite', runId: run.id })
    const paneKey = runtime.getTerminalPaneKey(terminal.handle)
    const incarnation = runtime.getTerminalProcessIncarnation(terminal.handle)
    if (!paneKey || !incarnation) {
      throw new Error('Runtime did not expose the worker pane identity.')
    }
    const dispatch = createRootDispatch(
      db,
      task.id,
      terminal.handle,
      paneKey,
      'launch-hash', // A dispatch recorded against a process that has since been replaced.
      opts?.breakIdentity === true ? `${incarnation}:replaced` : incarnation
    )
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey,
      processIncarnation: opts?.breakIdentity === true ? `${incarnation}:replaced` : incarnation
    })

    const method = workerShowMethod()
    return method.handler(method.params?.parse({ dispatch: dispatch.id }), { runtime })
  }

  it('names the pending prompt on the observation a coordinator polls', async () => {
    const result = await showWorkerPaneServing(fixture('cursor-agent-approval-prompt'))

    expect(result).toMatchObject({
      observation: {
        exactWorker: true,
        agentWait: {
          source: 'prompt-text',
          reason: 'agent-approval-prompt',
          since: expect.any(Number)
        }
      }
    })
  })

  it('reports an explicit null for the same lane inside a long tool call', async () => {
    // Why an explicit null and not an omitted key: a coordinator has to tell "not waiting"
    // from "this host is too old to know", and only absence may mean the latter.
    const result = await showWorkerPaneServing(fixture('cursor-agent-long-tool-call'))

    expect(result).toMatchObject({ observation: { exactWorker: true, agentWait: null } })
  })

  it('omits the field entirely for a worker it could not verify', async () => {
    // Why not null: null is a claim that Orca looked. A replaced process is never looked at,
    // and reporting "no wait" there is the false negative this field exists to remove.
    const result = (await showWorkerPaneServing(fixture('cursor-agent-approval-prompt'), {
      breakIdentity: true
    })) as { observation: Record<string, unknown> }

    expect(result.observation.exactWorker).toBe(false)
    expect('agentWait' in result.observation).toBe(false)
  })

  it('agrees with the terminal payload it is derived from', async () => {
    const result = (await showWorkerPaneServing(fixture('cursor-agent-approval-prompt'))) as {
      terminal: { agentWait: unknown } | null
      observation: { agentWait: unknown }
    }

    // Why the explicit shape first: comparing the two fields alone passes when both are absent.
    expect(result.observation.agentWait).toMatchObject({
      source: 'prompt-text',
      reason: 'agent-approval-prompt'
    })
    expect(result.observation.agentWait).toEqual(result.terminal?.agentWait)
  })
})
