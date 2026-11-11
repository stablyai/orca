import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { refuseClaimedWorkerTerminal } from '../../../../orchestration/db/worker-dispatch/worker-terminal-claim'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const TERMINAL = 'term_windows_worker'

// One claim owner: local Dispatches and paired-server attachments refuse each other before any wait.
describe('a paired-server worker start onto a terminal another Dispatch holds', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function workerHost() {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederationWorkerRuntime(runtime, TERMINAL)
    vi.spyOn(runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'repo::windows-worktree',
      path: '/workspace/windows-worktree',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    vi.spyOn(runtime, 'subscribeToTerminalData').mockReturnValue(() => {})
    return { db, runtime }
  }

  function attach(runtime: OrcaRuntimeService, dispatchId: string): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!
    return method.handler(
      method.params!.parse({
        runId: 'run-home',
        dispatchId,
        taskId: `task_${dispatchId}`,
        taskSpec: 'remote worker',
        protocolVersion: 3,
        worktree: 'id:repo::windows-worktree',
        terminal: TERMINAL
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: `request_${dispatchId}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `payload_${dispatchId}`
        }
      }
    )
  }

  const attachments = (db: OrchestrationDb) =>
    db.db.prepare('SELECT dispatch_id FROM remote_dispatch_attachments').all()

  it('refuses a second attach while the first is still waiting for the agent', async () => {
    const { db, runtime } = workerHost()
    const held = Promise.withResolvers<void>()
    const wait = vi.mocked(runtime.waitForTerminal).getMockImplementation()!
    vi.mocked(runtime.waitForTerminal).mockImplementationOnce(async (...args) => {
      await held.promise
      return wait(...args)
    })
    const first = attach(runtime, 'ctx_first')
    await vi.waitFor(() => expect(runtime.waitForTerminal).toHaveBeenCalledTimes(1))

    await expect(attach(runtime, 'ctx_second')).rejects.toMatchObject({
      code: 'terminal_busy',
      message: expect.stringContaining('is still starting on it'),
      data: { effectsApplied: false, dispatchId: 'ctx_first' }
    })
    expect(attachments(db)).toEqual([{ dispatch_id: 'ctx_first' }])
    expect(runtime.waitForTerminal).toHaveBeenCalledTimes(1)
    held.resolve()
    await expect(first).resolves.toMatchObject({ state: 'ready' })
  })

  it('refuses an attach onto a ready attachment, and a local start onto either', async () => {
    const { db, runtime } = workerHost()
    await expect(attach(runtime, 'ctx_first')).resolves.toMatchObject({ state: 'ready' })

    await expect(attach(runtime, 'ctx_second')).rejects.toMatchObject({
      code: 'terminal_busy',
      data: { dispatchId: 'ctx_first' }
    })
    expect(() => refuseClaimedWorkerTerminal(db, TERMINAL, runtime, undefined)).toThrow(
      expect.objectContaining({
        code: 'terminal_busy',
        message: expect.stringContaining('started from another computer')
      })
    )
  })

  it('frees the terminal when an attach fails before it attaches', async () => {
    const { runtime } = workerHost()
    vi.mocked(runtime.waitForTerminal).mockResolvedValueOnce({
      handle: TERMINAL,
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })
    await expect(attach(runtime, 'ctx_first')).resolves.toMatchObject({ state: 'failed' })

    await expect(attach(runtime, 'ctx_second')).resolves.toMatchObject({ state: 'ready' })
  })

  it('refuses an attach onto a terminal a local Dispatch holds', async () => {
    const { db, runtime } = workerHost()
    const run = db.createRun({
      objective: 'local',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const local = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'local worker' }).id,
      assigneeHandle: TERMINAL,
      creator: { kind: 'system' },
      maxDepth: 10
    })

    await expect(attach(runtime, 'ctx_remote')).rejects.toMatchObject({
      code: 'terminal_busy',
      data: { effectsApplied: false, dispatchId: local.id }
    })
    expect(attachments(db)).toEqual([])
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
  })
})
