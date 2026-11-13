import { afterEach, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import type { TerminalProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { observedAgentInputMode } from '../../../../shared/agent-status/process/agent-process-input-mode'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { TERMINAL_METHODS } from '../../rpc/methods/terminal/terminal'

afterEach(() => vi.useRealTimers())

function inspection(argv: string[]): TerminalProcessInspection {
  const inputMode = observedAgentInputMode('/bin/claude', argv, true)
  return {
    foregroundProcess: 'claude',
    hasChildProcesses: true,
    foregroundObservation: {
      ptyId: TRANSCRIPT_PANE_PTY_ID,
      ptyIncarnationId: 'inc-1',
      authorityGeneration: 'host-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed',
      source: 'pty-master',
      foregroundKind: 'non-shell',
      processName: 'claude',
      ...(inputMode ? { inputMode } : {})
    }
  }
}

it.each([
  ['claude', 'mcp', 'serve'],
  ['claude', '--append-system-prompt', '', 'mcp', 'serve']
])('settles an observed MCP program without admitting agent input: %j', async (...argv) => {
  const writes: string[] = []
  const sample = inspection(argv)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    data: '\x1b]133;C\x07\x1b]0;claude\x07',
    processInspection: sample,
    onWrite: (data) => writes.push(data)
  })
  vi.useFakeTimers()
  const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 20_000 })
  await vi.advanceTimersByTimeAsync(3_000)
  await expect(waiting).resolves.toMatchObject({ satisfied: true })
  // Settlement removes its observation listener; the same current capability must reach send.
  expect(runtime.terminalAgentInputMode(handle)).toBe('noninteractive')
  expect(runtime.readTerminalMailHold(handle)).toEqual({ kind: 'busy-program' })
  await expect(
    runtime.sendTerminalAgentPrompt(handle, 'not an MCP request', { inputKind: 'driving' })
  ).rejects.toThrow('terminal_guard_not_writable')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  for (const type of ['desktop', 'mobile']) {
    const reply = dispatcher.dispatch(
      {
        id: type,
        authToken: 'token',
        method: 'terminal.send',
        params: {
          terminal: handle,
          text: 'not an MCP request',
          enter: true,
          agentPrompt: true,
          client: { id: type, type }
        }
      },
      { caller: { kind: 'paired-device', deviceId: 'pair' } }
    )
    await vi.advanceTimersByTimeAsync(0)
    await expect(reply).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
  }
  expect(writes).toEqual([])
  const raw = runtime.sendTerminal(handle, { text: 'raw protocol input' }, { inputKind: 'driving' })
  await vi.advanceTimersByTimeAsync(0)
  await expect(raw).resolves.toMatchObject({ accepted: true })
  expect(writes).toEqual(['raw protocol input'])
  // Repeated qualified completion retires the fact even when already at rest.
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]133;D;0\x07', Date.now())
  expect(runtime.terminalAgentInputMode(handle)).toBeUndefined()
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]133;D;0\x07', Date.now())
  expect(runtime.terminalAgentInputMode(handle)).toBeUndefined()
  if (sample.foregroundObservation?.verdict === 'observed') {
    delete sample.foregroundObservation.inputMode
  }
  runtime.onPtyData(
    TRANSCRIPT_PANE_PTY_ID,
    '\x1b]133;C\x07\x1b]0;claude\x07\x1b[?2031h\x1b[?2004h❯\u00a0',
    Date.now()
  )
  const interactive = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 20_000 })
  await vi.advanceTimersByTimeAsync(3_000)
  await expect(interactive).resolves.toMatchObject({ satisfied: true })
  expect(runtime.terminalAgentInputMode(handle)).toBeUndefined()
  runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
})

it('leaves interactive empty-option Claude on its composer contract when mode is absent', async () => {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    data: '\x1b]133;C\x07\x1b]0;claude\x07shell hook text',
    processInspection: inspection(['claude', '--append-system-prompt', ''])
  })
  vi.useFakeTimers()
  const abort = new AbortController()
  const waiting = runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: 20_000,
    signal: abort.signal
  })
  const settled = vi.fn()
  waiting.then(settled, () => {})
  await vi.advanceTimersByTimeAsync(4_000)
  expect(settled).not.toHaveBeenCalled()
  expect(runtime.terminalAgentInputMode(handle)).toBeUndefined()
  abort.abort()
  await expect(waiting).rejects.toThrow()
  runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
})

it('shares known-Claude enrichment across a thousand concurrent waiters and retires cancelled interest', async () => {
  const reads = vi.fn()
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    data: '\x1b]133;C\x07\x1b]0;claude\x07hook output',
    processInspection: { foregroundProcess: null, hasChildProcesses: true },
    onProcessInspection: reads
  })
  vi.useFakeTimers()
  const abort = new AbortController()
  const waits = Array.from({ length: 1_000 }, () =>
    runtime
      .waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 120_000,
        signal: abort.signal
      })
      .catch(() => null)
  )
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads.mock.calls.length).toBeGreaterThan(0)
  expect(reads.mock.calls.length).toBeLessThanOrEqual(6)
  abort.abort()
  await Promise.all(waits)
  const stopped = reads.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reads).toHaveBeenCalledTimes(stopped)
  runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
})
