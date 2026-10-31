import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { deliverTerminalAgentLaunchPrompt } from './rpc/methods/agent-launch-terminal-prompt'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'

export function registerTerminalPtyExitWaiterTests(): void {
  type RuntimeInternals = {
    recordPtyWorktree: (
      ptyId: string,
      worktreeId: string,
      state?: { connected?: boolean }
    ) => unknown
    ptyExitListenersByPtyId: Map<string, Set<unknown>>
    ptysById: Map<string, { connected: boolean; lastExitCode: number | null }>
  }

  function internals(runtime: OrcaRuntimeService): RuntimeInternals {
    return runtime as unknown as RuntimeInternals
  }

  function registerLivePty(runtime: OrcaRuntimeService): void {
    internals(runtime).recordPtyWorktree('pty-1', 'wt-1', { connected: true })
  }

  describe('PTY exit subscription', () => {
    it('fires on the backing PTY exit', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(internals(runtime).ptyExitListenersByPtyId.get('pty-1')).toHaveLength(1)

      runtime.onPtyExit('pty-1', 0)

      expect(listener).toHaveBeenCalledOnce()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })

    it('does not retain listeners across subscription churn', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const listener = vi.fn()

      for (let index = 0; index < 25; index += 1) {
        runtime.subscribeToPtyExit('pty-1', listener)()
      }
      runtime.onPtyExit('pty-1', 0)

      expect(listener).not.toHaveBeenCalled()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })

    it('fires immediately when the PTY already exited', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      runtime.onPtyExit('pty-1', 0)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).toHaveBeenCalledOnce()
      expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
    })
  })

  describe('idle and fresh readiness waits on an exited terminal', () => {
    it.each(
      (['pi', 'claude', 'codex', 'opencode'] as const).flatMap((agent) =>
        [true, false].map((exitBeforeWait) => ({ agent, exitBeforeWait }))
      )
    )(
      '$agent preserves the exit cause (exit before wait: $exitBeforeWait)',
      async ({ agent, exitBeforeWait }) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'shell',
          foregroundProcess: 'bash',
          launchAgent: agent,
          data: ''
        })
        vi.useFakeTimers()
        try {
          const cause = { kind: 'signaled' as const, signal: 9 }
          const exit = () =>
            runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', {
              providerExitObserved: true,
              cause
            })
          if (exitBeforeWait) {
            exit()
          }
          const waits = [
            runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 }),
            waitForWorkerAgentReady(runtime, handle, {
              agent,
              reusesTerminal: false,
              timeoutMs: 100
            })
          ]
          const outcomes = Promise.all(waits.map((wait) => wait.catch((error: unknown) => error)))
          if (!exitBeforeWait) {
            exit()
          }
          const settled = vi.fn()
          outcomes.then(settled)
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledOnce()
          for (const error of await outcomes) {
            expect(error).toBeInstanceOf(Error)
            expect(error).toMatchObject({ message: 'terminal_exited', terminalExitCause: cause })
          }
          await expect(
            runtime.waitForTerminal(handle, { condition: 'exit' })
          ).resolves.toMatchObject({
            status: 'exited',
            exitCode: 137,
            exitCause: cause
          })
          expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
        } finally {
          vi.useRealTimers()
        }
      }
    )
  })

  describe('fresh composer lifetime', () => {
    it('bounds exit work by affected composer operations at N and 10N', async () => {
      for (const n of [2, 20]) {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'shell',
          foregroundProcess: 'bash',
          data: ''
        })
        const otherPtyId = 'pty-unrelated'
        const other = runtime['recordPtyWorktree'](otherPtyId, 'wt-1', {
          connected: true,
          incarnationId: 'inc-other'
        })
        const otherHandle = runtime['issuePtyHandle'](other)
        const registry = runtime['terminalWaiters']
        const listeners = runtime['terminalStreamConsumers']['dataListeners']
        const pending: Promise<unknown>[] = []
        vi.useFakeTimers()
        try {
          const otherSettled = vi.fn()
          pending.push(
            ...Array.from({ length: n }, () =>
              runtime.waitForFreshWorkerComposer(otherHandle, 'claude', 60_000).catch(otherSettled)
            )
          )
          const add = vi.spyOn(registry, 'add')
          const resolve = vi.spyOn(registry, 'resolve')
          const remove = vi.spyOn(registry, 'remove')
          const lookup = vi.spyOn(registry['byPtyId'], 'get')
          const settled = vi.fn((error: unknown) => error)
          pending.push(
            ...Array.from({ length: n }, () =>
              runtime.waitForFreshWorkerComposer(handle, 'claude', 60_000).catch(settled)
            )
          )
          const targetData = listeners.get(TRANSCRIPT_PANE_PTY_ID)!
          const otherData = listeners.get(otherPtyId)!
          expect(targetData.size).toBe(n)
          expect(otherData.size).toBe(n)
          const targetDelete = vi.spyOn(targetData, 'delete')
          const otherDelete = vi.spyOn(otherData, 'delete')
          runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
          await vi.advanceTimersByTimeAsync(0)
          expect(add).toHaveBeenCalledTimes(n)
          expect(resolve).toHaveBeenCalledTimes(n)
          expect(remove).toHaveBeenCalledTimes(2 * n)
          expect(settled).toHaveBeenCalledTimes(n)
          expect(
            settled.mock.calls.every(
              ([error]) => error instanceof Error && error.message === 'terminal_exited'
            )
          ).toBe(true)
          expect(lookup.mock.calls.length).toBeLessThanOrEqual(4 * n + 4)
          expect(lookup.mock.calls.every(([id]) => id === TRANSCRIPT_PANE_PTY_ID)).toBe(true)
          expect(
            [...resolve.mock.calls, ...remove.mock.calls].every(
              ([waiter]) => waiter.ptyId === TRANSCRIPT_PANE_PTY_ID
            )
          ).toBe(true)
          expect(targetDelete).toHaveBeenCalledTimes(n)
          expect(otherDelete).not.toHaveBeenCalled()
          expect(otherSettled).not.toHaveBeenCalled()
          expect(registry.forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
          expect(registry.forPty(otherPtyId)).toHaveLength(n)
          expect(listeners.has(TRANSCRIPT_PANE_PTY_ID)).toBe(false)
          expect(otherData.size).toBe(n)
          runtime.onPtyExit(otherPtyId, 137, 'inc-other', { providerExitObserved: true })
          await Promise.all(pending)
          expect(registry['byPtyId'].size).toBe(0)
          expect(listeners.size).toBe(0)
        } finally {
          registry.rejectAll('request_aborted')
          await Promise.all(pending)
          vi.useRealTimers()
          vi.restoreAllMocks()
        }
      }
    })

    it.each(['exit', 'replacement', 'prune', 'graph-retirement', 'abort', 'timeout'] as const)(
      'retires its scanner, listeners and deadline on %s',
      async (end) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'shell',
          foregroundProcess: 'bash',
          data: ''
        })
        const subscribe = vi.spyOn(runtime, 'subscribeToTerminalData')
        const stop = new AbortController()
        const removeAbort = vi.spyOn(stop.signal, 'removeEventListener')
        vi.useFakeTimers()
        try {
          const deadlines = vi.spyOn(globalThis, 'setTimeout')
          const clearDeadline = vi.spyOn(globalThis, 'clearTimeout')
          const pending = runtime.waitForFreshWorkerComposer(handle, 'claude', 60_000, {
            signal: stop.signal
          })
          const outcome = pending.catch((error: unknown) => error)
          const settled = vi.fn()
          outcome.then(settled)
          expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(1)
          expect(subscribe).toHaveBeenCalledOnce()
          const deadline =
            deadlines.mock.results[deadlines.mock.calls.findIndex(([, ms]) => ms === 60_000)].value
          if (end === 'exit') {
            runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
          } else if (end === 'replacement') {
            runtime.onPtySpawned(TRANSCRIPT_PANE_PTY_ID, 'inc-2')
            runtime['recordPtyWorktree'](TRANSCRIPT_PANE_PTY_ID, 'wt-1', {
              connected: true,
              incarnationId: 'inc-2'
            })
            runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
          } else if (end === 'prune') {
            runtime['dropDisconnectedPtyRecord'](TRANSCRIPT_PANE_PTY_ID)
          } else if (end === 'graph-retirement') {
            runtime['restoreHeadlessGraphAuthority']()
          } else if (end === 'abort') {
            stop.abort()
          } else {
            await vi.advanceTimersByTimeAsync(60_000)
          }
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledOnce()
          expect(await outcome).toMatchObject({
            message:
              end === 'exit'
                ? 'terminal_exited'
                : end === 'abort'
                  ? 'request_aborted'
                  : end === 'timeout'
                    ? 'timeout'
                    : 'terminal_handle_stale'
          })
          expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
          expect(
            runtime['terminalStreamConsumers']['dataListeners'].get(TRANSCRIPT_PANE_PTY_ID)
          ).toBeUndefined()
          expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
          expect(clearDeadline).toHaveBeenCalledWith(deadline)
        } finally {
          vi.useRealTimers()
          vi.restoreAllMocks()
        }
      }
    )

    it.each(['accept-exit', 'exit', 'replacement'] as const)(
      'ignores a late acceptance/foreground success after %s',
      async (end) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'claude',
          launchAgent: 'claude',
          data: ''
        })
        const foreground = Promise.withResolvers<'agent'>()
        const probe = vi
          .spyOn(runtime, 'readLaunchedAgentForeground')
          .mockReturnValue(foreground.promise)
        vi.useFakeTimers()
        try {
          const outcome = runtime
            .waitForFreshWorkerComposer(handle, 'claude', 60_000)
            .catch((error: unknown) => error)
          runtime.onPtyData(
            TRANSCRIPT_PANE_PTY_ID,
            readRuntimeFixture('claude-2-1-310-timed-boot-no-title'),
            Date.now()
          )
          if (end !== 'accept-exit') {
            await vi.advanceTimersByTimeAsync(0)
            expect(probe).toHaveBeenCalled()
          }
          if (end !== 'replacement') {
            runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
          } else {
            runtime.onPtySpawned(TRANSCRIPT_PANE_PTY_ID, 'inc-2')
          }
          const settled = vi.fn()
          outcome.then(settled)
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledOnce()
          expect(await outcome).toMatchObject({
            message: end !== 'replacement' ? 'terminal_exited' : 'terminal_handle_stale'
          })
          foreground.resolve('agent')
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledOnce()
          expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
          expect(
            runtime['terminalStreamConsumers']['dataListeners'].get(TRANSCRIPT_PANE_PTY_ID)
          ).toBeUndefined()
        } finally {
          vi.useRealTimers()
          vi.restoreAllMocks()
        }
      }
    )

    it.each(['claude', 'opencode'] as const)(
      'does not deliver a %s launch prompt after end',
      async (agent) => {
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'shell',
          foregroundProcess: 'bash',
          data: ''
        })
        const send = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        vi.useFakeTimers()
        try {
          const delivered = deliverTerminalAgentLaunchPrompt({
            runtime,
            handle,
            agent,
            freshLaunch: true,
            text: 'do the task'
          })
          runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
          const settled = vi.fn()
          delivered.then(settled)
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledExactlyOnceWith(false)
          expect(send).not.toHaveBeenCalled()
          expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
        } finally {
          vi.useRealTimers()
          vi.restoreAllMocks()
        }
      }
    )
  })

  // Disconnected without an exit code means lost contact, not process exit; false end events exhaust phone retries and lock its composer.
  describe('PTY exit subscription demands proof of exit, not loss of connection', () => {
    function dropTheConnection(runtime: OrcaRuntimeService): void {
      const pty = internals(runtime).ptysById.get('pty-1')!
      pty.connected = false
      // Precondition: onPtyExit is the only writer of lastExitCode, and it never ran.
      expect(pty.lastExitCode).toBeNull()
    }

    it('does not fire for a disconnected PTY that never reported an exit code', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      dropTheConnection(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).not.toHaveBeenCalled()
      expect(internals(runtime).ptyExitListenersByPtyId.get('pty-1')).toHaveLength(1)
    })

    it('still fires once the host comes back and reports the real exit', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      dropTheConnection(runtime)
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)
      expect(listener).not.toHaveBeenCalled()

      // Why: subscribing during the outage must not cost the subscriber the later exit.
      runtime.onPtyExit('pty-1', 0)

      expect(listener).toHaveBeenCalledOnce()
    })

    it('fires immediately for a disconnected PTY that did report an exit code', () => {
      const runtime = new OrcaRuntimeService()
      registerLivePty(runtime)
      const pty = internals(runtime).ptysById.get('pty-1')!
      pty.connected = false
      pty.lastExitCode = 0
      const listener = vi.fn()

      runtime.subscribeToPtyExit('pty-1', listener)

      expect(listener).toHaveBeenCalledOnce()
    })
  })

  const TARGET_LOOKUP_ERROR = new Error('identity_lookup_override')

  class IdentityRuntime extends OrcaRuntimeService {
    readonly identityCalls: [string, number][] = []

    override createPreAllocatedTerminalHandle(): string {
      this.identityCalls.push(['allocate', arguments.length])
      return 'term_identity_fixture'
    }

    protected override invalidatePtyIncarnationHandle(_ptyId: string): void {
      this.identityCalls.push(['invalidate', arguments.length])
    }

    protected override getLeavesForPty(_ptyId: string) {
      this.identityCalls.push(['leaves', arguments.length])
      return []
    }

    protected override nextTitleObservationSequence(): number {
      this.identityCalls.push(['title-sequence', arguments.length])
      return 41
    }

    protected override setPtyManagementTitleFromObservedTitle(
      ...args: Parameters<OrcaRuntimeService['setPtyManagementTitleFromObservedTitle']>
    ): void {
      this.identityCalls.push(['management-title', args.length])
    }

    protected override recordPtyWorktree(
      ...args: Parameters<OrcaRuntimeService['recordPtyWorktree']>
    ) {
      this.identityCalls.push(['record', args.length])
      return super.recordPtyWorktree(...args)
    }

    protected override getLivePtyForHandle(_handle: string): never {
      this.identityCalls.push(['target', arguments.length])
      throw TARGET_LOOKUP_ERROR
    }

    recordTitle(ptyId: string, worktreeId: string) {
      return this.recordPtyWorktree(ptyId, worktreeId, { title: 'Observed title' })
    }

    resolveRecordedPty(ptyId: string) {
      return this.getOrCreatePtyWorktreeRecord(ptyId)
    }

    assertTarget(handle: string, ptyId: string): void {
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    }
  }

  describe('terminal identity uses runtime overrides', () => {
    it('reserves the overridden handle and reuses it', () => {
      const runtime = new IdentityRuntime()

      expect(runtime.preAllocateHandleForPty('pty-1')).toBe('term_identity_fixture')
      expect(runtime.preAllocateHandleForPty('pty-1')).toBe('term_identity_fixture')
      expect(runtime.identityCalls).toEqual([['allocate', 0]])
    })

    it('registers through runtime invalidation and leaf lookup', () => {
      const runtime = new IdentityRuntime()

      runtime.registerPreAllocatedHandleForPty('pty-1', 'term_registered')

      expect(runtime.identityCalls).toEqual([
        ['invalidate', 1],
        ['leaves', 1]
      ])
    })

    it('records an observed title through runtime title callbacks', () => {
      const runtime = new IdentityRuntime()
      const pty = runtime.recordTitle('pty-1', 'repo::/worktree')

      expect(pty.titleUpdatedAt).toBe(41)
      expect(runtime.identityCalls).toEqual([
        ['record', 3],
        ['title-sequence', 0],
        ['management-title', 3]
      ])
    })

    it('infers a worktree through the runtime record method with two arguments', () => {
      const runtime = new IdentityRuntime()
      const pty = runtime.resolveRecordedPty('repo::/worktree@@pty-1')

      expect(pty?.worktreeId).toBe('repo::/worktree')
      expect(runtime.identityCalls).toEqual([['record', 2]])
    })

    it('preserves the overridden target lookup error', () => {
      const runtime = new IdentityRuntime()

      expect(() => runtime.assertTarget('term_target', 'pty-1')).toThrow(TARGET_LOOKUP_ERROR)
      expect(runtime.identityCalls).toEqual([['target', 1]])
    })
  })
}
