import type {
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations/history/automation-run'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../shared/ansi-escape-sequences'
import { isProvenProcessExit } from '../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import { createAutomationShellReceiptScanner } from '../../shared/automations/launch/automation-shell-exit-receipt'
import { createAutomationOutputSnapshotBuffer } from './automation-launch'
import type { TerminalExitCause } from '../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'

/** The runtime surface a shell run settles on: its own PTY incarnation, host stream and exit. */
export type ShellRunTerminalHost = {
  resolveTerminalPane?(
    paneKey: string,
    workspaceId?: string
  ): { handle: string; ptyId: string | null; incarnationId?: string | null; connected?: boolean }
  subscribeToTerminalData?(ptyId: string, listener: (data: string) => void): () => void
  subscribeToPtyExit?(ptyId: string, listener: () => void): () => void
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle' | 'exit'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{
    satisfied: boolean
    blockedReason?: string
    exitCode?: number | null
    exitCause?: TerminalExitCause | null
  }>
  readTerminal(
    handle: string,
    opts?: { limit?: number },
    snapshot?: { streamOnly?: boolean }
  ): Promise<{ tail: string[]; truncated?: boolean; limited?: boolean }>
}

/** Settles exit-condition runs from their own PTY; every other run keeps the agent observer. */
export function withShellRunCompletion(
  runtime: ShellRunTerminalHost,
  observer: AutomationRunTerminalObserver
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal: (run) =>
      run.completionCondition === 'exit'
        ? resolveShellRunTerminal(runtime, run)
        : observer.resolveRunTerminal(run),
    observeCompletion: (handle, options) =>
      options.run?.completionCondition === 'exit'
        ? observeShellRunCompletion(
            runtime,
            handle,
            options.run,
            options.signal,
            options.onUnverifiable,
            options.onCommandExit
          )
        : observer.observeCompletion(handle, options)
  }
}

function resolveShellRunTerminal(runtime: ShellRunTerminalHost, run: AutomationRun): string | null {
  if (!run.terminalPaneKey || !run.terminalPtyId || !run.terminalIncarnationId) {
    return null
  }
  try {
    const terminal = runtime.resolveTerminalPane?.(
      run.terminalPaneKey,
      run.workspaceId ?? undefined
    )
    return terminal?.ptyId === run.terminalPtyId &&
      terminal.incarnationId === run.terminalIncarnationId
      ? terminal.handle
      : null
  } catch {
    return null
  }
}

function resolveRunHandle(
  runtime: ShellRunTerminalHost,
  run: AutomationRun,
  fallback: string
): string {
  if (!runtime.resolveTerminalPane || !run.terminalPaneKey) {
    return fallback
  }
  const terminal = runtime.resolveTerminalPane(run.terminalPaneKey, run.workspaceId ?? undefined)
  if (
    terminal.ptyId !== run.terminalPtyId ||
    terminal.incarnationId !== run.terminalIncarnationId
  ) {
    throw new Error('terminal_incarnation_changed')
  }
  return terminal.handle
}

export async function observeShellRunCompletion(
  runtime: ShellRunTerminalHost,
  handle: string,
  run: AutomationRun,
  signal: AbortSignal,
  onUnverifiable?: (snapshot: AutomationRunOutputSnapshot | null) => void,
  onCommandExit?: (exitCode: number) => void
): Promise<AutomationRunCompletionObservation> {
  if (!run.terminalPtyId || !runtime.subscribeToTerminalData) {
    throw new Error('terminal_not_found')
  }
  const boundHandle = resolveRunHandle(runtime, run, handle)
  let wakeExit = (): void => {}
  const hostExit = new Promise<void>((resolve) => {
    wakeExit = resolve
  })
  const unsubscribeExit = runtime.subscribeToPtyExit?.(run.terminalPtyId, () => wakeExit())
  signal.addEventListener('abort', wakeExit, { once: true })
  // Capture the existing host tail before subscribing, without an async renderer read between them.
  const initial = runtime
    .readTerminal(boundHandle, { limit: 2_000 }, { streamOnly: true })
    .catch(() => ({ tail: [], truncated: false, limited: false }))
  const live = createAutomationOutputSnapshotBuffer()
  let commandExitCode: number | null = run.terminalCommandExitCode ?? null
  const receipt = createAutomationShellReceiptScanner(run.id, (code) => {
    commandExitCode = code
    onCommandExit?.(code)
  })
  const unsubscribe = runtime.subscribeToTerminalData(run.terminalPtyId, (data) => {
    try {
      resolveRunHandle(runtime, run, boundHandle)
    } catch {
      return
    }
    receipt.scan(data)
    live.append(data)
  })
  try {
    const seed = await initial
    receipt.scan(seed.tail.join('\n'))
    const snapshot = (): AutomationRunOutputSnapshot | null => {
      const buffer = createAutomationOutputSnapshotBuffer()
      buffer.append(seed.tail.join('\n') || run.outputSnapshot?.content || '')
      const captured = live.snapshot()
      if ((seed.tail.length || run.outputSnapshot?.content) && captured) {
        buffer.append('\n')
      }
      buffer.append(captured?.content ?? '')
      const output = buffer.snapshot()
      if (output) {
        output.content = stripAnsiEscapeSequences(output.content)
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
          .trim()
        output.truncated ||=
          (captured?.truncated ?? false) || seed.truncated === true || seed.limited === true
        if (!seed.tail.length) {
          output.truncated ||= run.outputSnapshot?.truncated ?? false
        }
      }
      return output
    }
    try {
      const running =
        run.terminalPaneKey &&
        runtime.resolveTerminalPane?.(run.terminalPaneKey, run.workspaceId ?? undefined).connected
      if (unsubscribeExit && running && !signal.aborted) {
        await hostExit
      }
      if (signal.aborted) {
        throw new Error('request_aborted')
      }
      const wait = await runtime.waitForTerminal(resolveRunHandle(runtime, run, boundHandle), {
        condition: 'exit',
        signal
      })
      const hostObservedExit =
        typeof wait.exitCode === 'number' && isProvenProcessExit(wait.exitCode)
      const exitCode = hostObservedExit ? commandExitCode : null
      if (wait.satisfied && exitCode !== null) {
        return {
          status: exitCode === 0 ? 'completed' : 'dispatch_failed',
          outputSnapshot: snapshot(),
          error: exitCode === 0 ? null : `Automation process exited with code ${exitCode}.`
        }
      }
      if (
        wait.satisfied &&
        hostObservedExit &&
        (wait.exitCause?.kind === 'signaled' || wait.exitCause?.kind === 'operator_close')
      ) {
        return {
          status: 'dispatch_failed',
          outputSnapshot: snapshot(),
          error:
            wait.exitCause.kind === 'signaled'
              ? `Automation process was killed by signal ${wait.exitCause.signal}.`
              : 'The automation terminal was closed before the command completed.'
        }
      }
      throw new Error('automation_exit_unverifiable')
    } catch (error) {
      if (!signal.aborted) {
        onUnverifiable?.(snapshot())
      }
      throw error
    }
  } finally {
    signal.removeEventListener('abort', wakeExit)
    unsubscribeExit?.()
    unsubscribe()
  }
}
