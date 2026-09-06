import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'
import { isProvenProcessExit } from '../../shared/terminal-exit-cause'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

/** The runtime surface an authority uses to observe its own terminals. */
export type AutomationRunTerminalHost = {
  resolveTerminalPane(
    paneKey: string,
    expectedWorktreeId?: string
  ): { handle: string; ptyId: string | null }
  waitForTerminal(
    handle: string,
    options?: { condition?: 'exit' | 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ satisfied: boolean; exitCode?: number | null; blockedReason?: string }>
  subscribeToPtyExit(ptyId: string, listener: () => void): () => void
  readTerminal(
    handle: string,
    opts?: { limit?: number }
  ): Promise<{ tail: string[]; truncated?: boolean; limited?: boolean }>
}

export function createRuntimeAutomationRunTerminalObserver(
  runtime: AutomationRunTerminalHost
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal: (run) => {
      if (!run.terminalPaneKey) {
        return null
      }
      try {
        const terminal = runtime.resolveTerminalPane(
          run.terminalPaneKey,
          run.workspaceId ?? undefined
        )
        return !run.terminalPtyId || terminal.ptyId === run.terminalPtyId ? terminal.handle : null
      } catch {
        return null
      }
    },
    observeCompletion: async (handle, { signal, terminalPtyId }) => {
      const capture = () => runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })
      let finalCapture: ReturnType<typeof capture> | undefined
      const unsubscribe = terminalPtyId
        ? runtime.subscribeToPtyExit(terminalPtyId, () => {
            // Exit subscribers run before the runtime releases its bounded transcript.
            finalCapture = capture()
            void finalCapture.catch(() => {})
          })
        : () => {}
      try {
        // Agent idle is a turn signal, never proof that this run's process exited.
        const wait = await runtime.waitForTerminal(handle, { condition: 'exit', signal })
        if (!wait.satisfied || wait.exitCode == null || !isProvenProcessExit(wait.exitCode)) {
          return {
            status: 'dispatch_failed',
            error: 'Orca lost contact with this run before its process exit could be verified.'
          }
        }
        // Capture must finish before the watcher can publish a terminal run status.
        const read = await (finalCapture ?? capture())
        const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
        snapshotBuffer.append(read.tail.join('\n'))
        const outputSnapshot = snapshotBuffer.snapshot()
        if (outputSnapshot && (read.truncated || read.limited)) {
          outputSnapshot.truncated = true
        }
        return {
          status: wait.exitCode === 0 ? 'completed' : 'dispatch_failed',
          outputSnapshot,
          error:
            wait.exitCode === 0 ? null : `Automation process exited with code ${wait.exitCode}.`
        }
      } finally {
        unsubscribe()
      }
    }
  }
}
