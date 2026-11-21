import { describe, expect, it, vi } from 'vitest'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../git/worktrees/catalog/worktree-scan-cache'

import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import '../../session-lifecycle/close/mobile-session-tab-close-outcome'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps the original committed disposition across an idempotent retry', async () => {
    const runtime = new OrcaRuntimeService(store)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const processLists = [
      [
        {
          id: 'pty-preserved-history',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Shell'
        }
      ],
      [],
      []
    ]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => processLists.shift() ?? []
    })

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-preserved-history'] })
    ])
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    const releaseSpawn = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(TEST_WORKTREE_ID, null)
    )
    releaseSpawn()

    const sleepEvents = events.filter((event) => event.type === 'worktreeTerminalSleepState')
    expect(sleepEvents.map((event) => event.phase)).toEqual(['started', 'committed', 'woken'])
    expect(sleepEvents.at(-1)?.ptyIds).toEqual(['pty-preserved-history'])
  })

  it('keeps concurrent sleep coalesced until every launched stop settles', async () => {
    const runtime = new OrcaRuntimeService(store)
    const clientEvents: RuntimeClientEvent[][] = [[], []]
    for (const events of clientEvents) {
      runtime.onClientEvent((event) => events.push(event))
    }
    const secondStop = deferred<boolean>()
    const failedPty = {
      id: 'pty-fails',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      title: 'Claude'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([
        failedPty,
        { id: 'pty-slow', cwd: TEST_WORKTREE_PATH, worktreeId: TEST_WORKTREE_ID, title: 'Shell' }
      ])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([failedPty])
      .mockResolvedValueOnce([])
    let failedAttempts = 0
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === 'pty-fails') {
        failedAttempts += 1
        if (failedAttempts === 1) {
          throw new Error('stop failed')
        }
        runtime.onPtyExit(ptyId, -1)
        return true
      }
      const stopped = await secondStop.promise
      runtime.onPtyExit(ptyId, -1)
      return stopped
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait,
      getForegroundProcess: async () => null,
      listProcesses
    })

    const first = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await vi.waitFor(() => expect(stopAndWait).toHaveBeenCalledTimes(2))
    const concurrent = runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    secondStop.resolve(true)

    await expect(first).rejects.toThrow('terminal_worktree_sleep_failed')
    await expect(concurrent).rejects.toThrow('terminal_worktree_sleep_failed')
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ phase: 'committed', ptyIds: ['pty-slow'] })
    ])
    await expect(
      runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    ).resolves.toMatchObject({ postStopVerified: true, stoppedPtyIds: ['pty-fails'] })
    expect(stopAndWait).toHaveBeenCalledTimes(3)
    for (const events of clientEvents) {
      const sleepEvents = events.filter(
        (event): event is Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }> =>
          event.type === 'worktreeTerminalSleepState'
      )
      expect(
        [
          ...new Set(
            sleepEvents
              .filter((event) => event.phase === 'committed')
              .flatMap((event) => event.ptyIds)
          )
        ].sort()
      ).toEqual(['pty-fails', 'pty-slow'])
      expect(
        sleepEvents.filter((event) => event.phase === 'cancelled').flatMap((event) => event.ptyIds)
      ).toEqual(['pty-fails'])
    }
  })

  it('reports recoverable post-stop liveness failure after exact terminal stop', async () => {
    const runtime = new OrcaRuntimeService(store)
    const stopped: string[] = []
    const processLists = [[{ id: 'pty-1', cwd: '/tmp/worktree-a', title: 'Claude' }]]
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: async (ptyId) => {
        stopped.push(ptyId)
        runtime.onPtyExit(ptyId, -1)
        return true
      },
      getForegroundProcess: async () => null,
      // Why: the daemon stays unavailable through every bounded post-stop retry.
      listProcesses: async () => {
        const next = processLists.shift()
        if (!next) {
          throw new Error('daemon unavailable')
        }
        return next
      }
    })

    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    await expect(
      runtime.stopExactTerminalsForWorktree('id:repo-1::/tmp/worktree-a', ['pty-1'])
    ).resolves.toEqual({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: ['pty-1'],
      postStopVerified: false,
      postStopFailure: 'terminal_liveness_unavailable'
    })
    expect(stopped).toEqual(['pty-1'])
  })
})
