import { describe, expect, it, vi } from 'vitest'

import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { readRuntimeFixture } from '../wait/agent-transcript-replay-test-harness'
import { deliverTerminalAgentLaunchPrompt } from '../../rpc/methods/agent-launch/agent-launch-terminal-prompt'
import { waitForWorkerAgentReady } from '../wait/launched-agent-composer-readiness'

export function registerTerminalPtyExitWaiterTests(): void {
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
}
