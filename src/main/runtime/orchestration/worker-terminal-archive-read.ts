import type { OrcaRuntimeService } from '../orca-runtime'
import { MAX_TERMINAL_READ_LIMIT } from '../terminal-tail-limits'
import { redactWorkerTerminalView } from './worker-terminal-redaction'

export async function readWorkerTerminalArchive(
  runtime: Pick<OrcaRuntimeService, 'readTerminal'>,
  handle: string
) {
  // Cursor reads retain completed history; the screen read also preserves partial output/drafts.
  const history = await runtime.readTerminal(handle, { cursor: 0, limit: MAX_TERMINAL_READ_LIMIT })
  const screen = await runtime.readTerminal(handle, {
    screen: true,
    limit: MAX_TERMINAL_READ_LIMIT
  })
  const hasScreen = screen.source === 'screen'
  const redactedHistory = redactWorkerTerminalView(history)
  const redactedScreen = redactWorkerTerminalView(screen)
  const alreadyRetained =
    redactedScreen.tail.length <= redactedHistory.tail.length &&
    redactedScreen.tail.every(
      (line, index) =>
        line ===
        redactedHistory.tail[redactedHistory.tail.length - redactedScreen.tail.length + index]
    )
  const appended = screen.tail.length > 0 && !alreadyRetained
  const warnings: string[] = []
  if (!hasScreen) {
    warnings.push(
      screen.source === 'screen-unavailable'
        ? 'The current terminal screen was unavailable; only retained stream output could be preserved.'
        : 'The terminal read did not identify an authoritative screen; available terminal output was preserved.'
    )
  } else if (appended) {
    warnings.push(
      history.tail.some((line) => line.trim() !== '')
        ? 'Terminal output includes retained stream history followed by the current screen; overlapping lines may appear more than once.'
        : 'Terminal output was preserved from the current terminal screen.'
    )
  }
  return {
    ...history,
    ...redactedHistory,
    tail: appended ? [...redactedHistory.tail, ...redactedScreen.tail] : redactedHistory.tail,
    ...(redactedScreen.draft ? { draft: redactedScreen.draft } : {}),
    truncated:
      history.truncated || history.limited === true || screen.truncated || screen.limited === true,
    warnings: [...new Set([...redactedHistory.warnings, ...redactedScreen.warnings, ...warnings])]
  }
}
