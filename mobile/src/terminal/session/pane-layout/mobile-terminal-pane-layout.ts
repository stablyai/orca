import type { TerminalSplitLayout } from '../../../storage/preferences'
import type { TerminalFrame } from '../../webview/terminal-webview-messages'

export type TerminalPaneViewport = {
  terminalFrameRef: { current: TerminalFrame | null }
  viewportRef: { current: { cols: number; rows: number } | null }
  viewportMeasuredRef: { current: boolean }
}

export function terminalPaneViewport(states: Map<string, TerminalPaneViewport>, handle: string) {
  let state = states.get(handle)
  if (!state) {
    state = {
      terminalFrameRef: { current: null },
      viewportRef: { current: null },
      viewportMeasuredRef: { current: false }
    }
    states.set(handle, state)
  }
  return state
}

export function resolveTerminalPaneHandles(
  active: string | null,
  pair: readonly string[] | null,
  available: readonly string[]
): string[] {
  if (!active) {
    return []
  }
  if (!pair) {
    return [active]
  }
  const surviving = pair.filter((handle) => available.includes(handle))
  if (surviving.includes(active)) {
    return surviving.length === 2 ? surviving : [active]
  }
  const companion = surviving.find((handle) => handle !== active)
  return companion ? [active, companion] : [active]
}

/** Each terminal row's last terminal handle, kept while the row waits for a new one. */
export type TerminalRowHandles = ReadonlyMap<string, string>

/** A host that restarts a pane keeps its row and gives it a new terminal: the split follows the
 *  row, as the selected pane does. Returns the rows' handles and each replaced handle's successor. */
export function followTerminalRows(
  previous: TerminalRowHandles,
  rows: readonly { type: string; id: string; terminal?: string | null }[]
): { handles: TerminalRowHandles; replaced: ReadonlyMap<string, string> } {
  const handles = new Map<string, string>()
  const replaced = new Map<string, string>()
  for (const row of rows) {
    if (row.type !== 'terminal') {
      continue
    }
    const last = previous.get(row.id)
    if (typeof row.terminal !== 'string') {
      if (last) {
        handles.set(row.id, last)
      }
      continue
    }
    if (last && last !== row.terminal) {
      replaced.set(last, row.terminal)
    }
    handles.set(row.id, row.terminal)
  }
  return { handles, replaced }
}

export function withReplacedTerminalHandles(
  pair: readonly string[] | null,
  replaced: ReadonlyMap<string, string>
): readonly string[] | null {
  return pair?.some((handle) => replaced.has(handle))
    ? pair.map((handle) => replaced.get(handle) ?? handle)
    : pair
}

const SPLIT_ROW_MIN_WIDTH = 600

/** A window this narrow (a phone held upright) only splits into rows; columns of it are too narrow to read. */
export function windowFitsSideBySide(windowWidth: number): boolean {
  return windowWidth >= SPLIT_ROW_MIN_WIDTH
}

export function terminalPaneDirection(
  frame: TerminalFrame,
  layout: TerminalSplitLayout = 'auto',
  windowWidth = frame.width
): 'row' | 'column' {
  // Side by side keeps columns beside an open sidebar, but not in a window too narrow to offer it.
  if (layout === 'side-by-side') {
    return windowFitsSideBySide(windowWidth) ? 'row' : 'column'
  }
  if (layout === 'stacked') {
    return 'column'
  }
  return frame.width >= SPLIT_ROW_MIN_WIDTH && frame.width > frame.height ? 'row' : 'column'
}

export function keepsTerminalPaneVisible(handle: string, visible: readonly string[] = []): boolean {
  return visible.length === 2 && visible.includes(handle)
}

export function terminalPaneKeyboardLayout(
  frame: TerminalFrame,
  direction: 'row' | 'column',
  index: number,
  keyboardInset: number
) {
  const originalHeight = direction === 'column' ? frame.height / 2 : frame.height
  const remainingHeight = Math.max(0, frame.height - Math.max(0, keyboardInset))
  const height = direction === 'column' ? remainingHeight / 2 : remainingHeight
  return {
    top: direction === 'column' ? index * height : 0,
    height,
    originalHeight,
    occlusion: originalHeight - height
  }
}
