import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

/** Installs the shared worker-release runtime fixture and returns the liveness probe spy. */
export function installWorkerReleaseRuntimeMocks(
  runtime: OrcaRuntimeService,
  paneKeys: { coordinator: string; worker: string }
): ReturnType<typeof vi.fn> {
  const inspectProcessLiveness = vi.fn().mockResolvedValue('live')
  ;(
    runtime as unknown as {
      inspectTerminalProcessIncarnationLiveness: typeof inspectProcessLiveness
    }
  ).inspectTerminalProcessIncarnationLiveness = inspectProcessLiveness
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord'
      ? paneKeys.coordinator
      : handle === 'term_worker' || handle === 'term_reminted'
        ? paneKeys.worker
        : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
  )
  // Why: the argv worker-start path pre-allocates the handle and hands the
  // spawn a launch token; the pane's authority must echo that token's hash
  // or the bind guard (rightly) refuses the pane. Pinning the pre-allocated
  // handle keeps every 'term_worker'-keyed fixture in this file valid.
  let workerLaunchTokenHash: string | null = null
  vi.spyOn(runtime, 'createPreAllocatedTerminalHandle').mockReturnValue('term_worker')
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === 'term_worker' || handle === 'term_reminted'
      ? ({
          terminalHandle: handle,
          paneKey: paneKeys.worker,
          processIncarnation: 'runtime_test:term_worker:1',
          ...(workerLaunchTokenHash ? { launchTokenHash: workerLaunchTokenHash } : {}),
          hostScope: { kind: 'local', hostId: 'local' }
        } as never)
      : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::worktree'
  } as never)
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_selector, opts) => {
    workerLaunchTokenHash = opts?.launchToken
      ? createHash('sha256').update(opts.launchToken).digest('hex')
      : null
    return { handle: 'term_worker', worktreeId: 'repo::worktree', title: 'worker' } as never
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'getWorktreeOrchestrationCliCommand').mockResolvedValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: 'term_worker',
    status: 'running',
    tail: ['worker output line 1', 'worker output line 2'],
    truncated: false,
    nextCursor: '2'
  })
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: 'term_worker',
    tabId: 'tab-worker',
    ptyKilled: true
  } as never)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return inspectProcessLiveness
}
