import type { TerminalCommandPaint } from '../input/terminal-command-paint'
import { extractOscTitleScanTail } from '../../../../shared/osc-title-scan-tail'

export function advanceTerminalTitleInput(tails: Map<string, string>, ptyId: string, data: string) {
  const previous = tails.get(ptyId) ?? ''
  const titleInput = previous + data
  const next = extractOscTitleScanTail(titleInput)
  if (next) {
    tails.set(ptyId, next)
  } else {
    tails.delete(ptyId)
  }
  return { titleInput, previousLength: previous.length }
}

export function terminalTitleOriginObserver(
  paint: TerminalCommandPaint | undefined,
  rawOffset: ((offset: number) => number) | undefined
): (title: string, end: number) => void {
  return (title, end) => paint?.observeTitle(title, rawOffset?.(end) ?? end)
}
