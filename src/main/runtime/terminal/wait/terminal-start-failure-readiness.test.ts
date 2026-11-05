import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import {
  waitForWorkerAgentReady,
  waitForLaunchedAgentComposer
} from './launched-agent-composer-readiness'
import {
  formatTerminalStartFailure,
  readTerminalStartFailure
} from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('accepted spawn followed by failed startup readiness', () => {
  it.each(
    (['fresh', 'repeated-exit', 'wrong-incarnation'] as const).flatMap((context) =>
      [true, false].map((exitBeforeWait) => ({ context, exitBeforeWait }))
    )
  )(
    'keeps what a launch printed when its PTY dies mid-command ($context, exitBeforeWait=$exitBeforeWait)',
    async ({ context, exitBeforeWait }) => {
      const { runtime, handle, terminal } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        launchAgent: 'hermes',
        data: '\x1b]133;C\x07\x1b[31mTraceback: startup failed\x1b[0m\r\nImportError: broken client\r\n'
      })
      const exit = () => {
        // A stop's cleanup can report the exit again after the buffer is gone.
        for (let report = context === 'repeated-exit' ? 2 : 1; report > 0; report -= 1) {
          runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 1, 'inc-1', {
            providerExitObserved: true,
            cause: { kind: 'exited', exitCode: 1 }
          })
        }
      }
      if (exitBeforeWait) {
        exit()
      }
      const result = waitForWorkerAgentReady(runtime, handle, {
        agent: 'hermes',
        reusesTerminal: false,
        creation:
          context === 'wrong-incarnation'
            ? { ...terminal, incarnationId: 'replacement' }
            : terminal,
        timeoutMs: 50
      }).catch((error: unknown) => error)
      if (!exitBeforeWait) {
        exit()
      }
      const error = await result
      expect(error).toHaveProperty('terminalExitCause', { kind: 'exited', exitCode: 1 })
      expect(String(error).includes('Traceback: startup failed\nImportError: broken client')).toBe(
        context !== 'wrong-incarnation'
      )
    }
  )

  it.each(
    (['pi', 'codex', 'claude', 'opencode'] as const).flatMap((agent) =>
      [true, false].map((exitBeforeWait) => ({ agent, exitBeforeWait }))
    )
  )(
    'carries the real $agent readiness exit into the start failure (exitBeforeWait=$exitBeforeWait)',
    async ({ agent, exitBeforeWait }) => {
      const { runtime, handle, terminal } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        launchAgent: agent,
        data: ''
      })
      vi.useFakeTimers()
      const exit = () =>
        runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 256, 'inc-1', {
          providerExitObserved: true,
          cause: {
            kind: 'exited',
            exitCode: 256,
            initialOutputDiagnostic: 'git-bash-console-capacity'
          }
        })
      if (exitBeforeWait) {
        exit()
      }
      const result = waitForWorkerAgentReady(runtime, handle, {
        agent,
        reusesTerminal: false,
        creation: terminal,
        timeoutMs: 50
      }).catch((error: unknown) => error)
      if (!exitBeforeWait) {
        exit()
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toMatchObject({
        message: expect.any(String),
        terminalExitCause: expect.objectContaining({ kind: 'exited' })
      })
      expect(formatTerminalStartFailure(await result)).toContain('128 open terminals on this PC')
      expect(readTerminalStartFailure(await result)?.incarnationId).toBe('inc-1')
    }
  )

  it.each(['fresh', 'reattach', 'adopted', 'missing', 'wrong-incarnation'] as const)(
    'uses actual create provenance independently of readiness scheduling (%s)',
    async (context) => {
      const { runtime, handle, terminal } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        data: '',
        launchAgent: 'pi',
        ...(context === 'reattach' ? { isReattach: true } : {})
      })
      const creation =
        context === 'missing'
          ? undefined
          : {
              ...terminal,
              ...(context === 'adopted' ? { agentSessionDisposition: 'adopted' as const } : {}),
              ...(context === 'wrong-incarnation' ? { incarnationId: 'replacement' } : {})
            }
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 256, 'inc-1', {
        providerExitObserved: true,
        cause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      vi.useFakeTimers()
      const worker = waitForWorkerAgentReady(runtime, handle, {
        agent: 'pi',
        reusesTerminal: false,
        timeoutMs: 50,
        creation
      }).catch((error: unknown) => error)
      const prompt = waitForLaunchedAgentComposer(
        runtime,
        handle,
        'pi',
        50,
        undefined,
        creation
      ).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      for (const result of await Promise.all([worker, prompt])) {
        expect(formatTerminalStartFailure(result) !== undefined).toBe(context === 'fresh')
      }
    }
  )
})
