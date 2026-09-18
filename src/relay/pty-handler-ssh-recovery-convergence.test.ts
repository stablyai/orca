// End to end over the boundary the fix is about: an SSH worker dies while the laptop is away, the
// laptop comes back much later, and the orchestration sweep settles it. Relay, SSH provider and
// recovery candidate all run for real here, so a disagreement between them fails the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { SshPtyProvider } from '../main/providers/ssh-pty-provider'
import { inspectExitedIncarnationFromRuntimeController } from '../main/ipc/pty/runtime/operations'
import { sshProviders } from '../main/ipc/pty/provider/registry'
import { toAppSshPtyId } from '../shared/ssh-pty-id'
import type { PtyIncarnationId } from '../shared/pty-incarnation'
import { reconcileLegacyWorkerCandidate } from '../main/runtime/runtime-legacy-worker-terminal-recovery-candidate'
import type { LegacyWorkerRecoveryResolution } from '../main/runtime/runtime-legacy-worker-terminal-recovery-types'
import { OrchestrationDb } from '../main/runtime/orchestration/db'
import {
  beginPtyHandlerTest,
  createTestPtyHandler,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'

const CONNECTION = 'recovery-convergence'

describe('SSH worker recovery converges on the relay exit', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let provider: SshPtyProvider
  let exitCallback: ((info: { exitCode: number }) => void) | undefined
  let ownerAccepts: boolean

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    exitCallback = undefined
    ownerAccepts = false
    mockPtySpawn.mockImplementation(() => ({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((callback: (info: { exitCode: number }) => void) => {
        exitCallback = callback
      })
    }))
    Object.assign(dispatcher, {
      onLegacyPtyCapacity: vi.fn(() => vi.fn()),
      tryNotifyPtyData: vi.fn(() => true),
      // The owning client is offline: the relay holds the exit instead of dropping it.
      tryNotifyPtyExit: vi.fn(() => ownerAccepts),
      legacyRetentionBelowLowWater: true
    })
    handler = createTestPtyHandler(dispatcher)
    provider = new SshPtyProvider(CONNECTION, {
      request: (method: string, params: Record<string, unknown>) =>
        dispatcher.callRequest(method, params),
      onNotification: () => () => {},
      onRequest: () => () => {}
    } as never)
    sshProviders.set(CONNECTION, provider)
  })

  afterEach(async () => {
    sshProviders.delete(CONNECTION)
    provider.dispose()
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function reconcile(
    appPtyId: string,
    incarnationId: PtyIncarnationId,
    dispatchId: string
  ): Promise<{
    pendingResolutions: LegacyWorkerRecoveryResolution[]
    deferredDispatchIds: Set<string>
  }> {
    const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
    const deferredDispatchIds = new Set<string>()
    await reconcileLegacyWorkerCandidate({
      controller: {} as never,
      ports: {
        // The production port, so the registry, the provider and the relay all answer for real.
        proveTerminalExited: (candidate) =>
          inspectExitedIncarnationFromRuntimeController(candidate.ptyId, candidate.incarnationId)
      } as never,
      options: { connectionId: CONNECTION },
      candidate: { dispatchId, ptyId: appPtyId, incarnationId } as never,
      workspace: {} as never,
      resolvedWorktrees: [],
      // The client's listing is empty: it was disconnected when the shell ended.
      inventory: { livePtyIds: new Set() } as never,
      pendingResolutions,
      deferredDispatchIds
    })
    return { pendingResolutions, deferredDispatchIds }
  }

  it('settles a worker whose exit the relay held through a long disconnect', async () => {
    const { id, incarnationId } = (await dispatcher.callRequest('pty.spawn', {})) as {
      id: string
      incarnationId: PtyIncarnationId
    }
    exitCallback?.({ exitCode: 0 })
    expect(handler.activePtyCount).toBe(0)
    expect(
      await dispatcher.callRequest('pty.listProcesses', {
        includeForegroundProcessEvidence: false
      })
    ).toEqual([])
    await vi.advanceTimersByTimeAsync(600_000)

    const appPtyId = toAppSshPtyId(CONNECTION, id)
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'recover a terminated SSH worker',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'coordinator:11111111-1111-4111-8111-111111111111'
      })
      const task = db.createTask({
        spec: 'recover a terminated SSH worker',
        runId: run.id
      })
      const start = {
        taskId: task.id,
        startOptions: {},
        creator: { kind: 'system' as const },
        maxDepth: 9
      }
      const { dispatch } = db.createStartingWorkerDispatch(start)
      db.markWorkerDispatchReady(dispatch.id)

      // Before the sweep the dispatch owns the task; a second worker cannot be started for it.
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
      expect(() => db.createStartingWorkerDispatch(start)).toThrow()

      const result = await reconcile(appPtyId, incarnationId, dispatch.id)

      expect(result.pendingResolutions).toEqual([
        {
          candidate: {
            dispatchId: dispatch.id,
            ptyId: appPtyId,
            incarnationId
          },
          resolution: 'exited'
        }
      ])
      expect([...result.deferredDispatchIds]).toEqual([])
    } finally {
      db.close()
    }
  })

  it('defers when the relay already handed that exit to its owner', async () => {
    ownerAccepts = true
    const { id, incarnationId } = (await dispatcher.callRequest('pty.spawn', {})) as {
      id: string
      incarnationId: PtyIncarnationId
    }
    exitCallback?.({ exitCode: 0 })

    // Main learned about this death through the stream; the sweep has no second source to consult.
    const result = await reconcile(toAppSshPtyId(CONNECTION, id), incarnationId, 'worker-delivered')

    expect(result.pendingResolutions).toEqual([])
    expect([...result.deferredDispatchIds]).toEqual(['worker-delivered'])
  })

  it('defers a shutdown that timed out while a sibling kill failure kept the relay serving', async () => {
    const { id, incarnationId } = (await dispatcher.callRequest('pty.spawn', {})) as {
      id: string
      incarnationId: PtyIncarnationId
    }
    const failedKill = vi.fn<() => void>(() => {
      throw new Error('host refused kill')
    })
    mockPtySpawn.mockReturnValueOnce({ ...mockPtyInstance, kill: failedKill })
    await dispatcher.callRequest('pty.spawn', {})

    const disposal = handler.dispose().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await disposal).toMatchObject({ message: 'host refused kill' })
    failedKill.mockImplementation(() => {})

    // The record is gone from the relay's map and nothing watched the shell end.
    expect(() => process.kill(process.pid, 0)).not.toThrow()
    const result = await reconcile(toAppSshPtyId(CONNECTION, id), incarnationId, 'worker-timeout')

    expect(result.pendingResolutions).toEqual([])
    expect([...result.deferredDispatchIds]).toEqual(['worker-timeout'])
  })
})
