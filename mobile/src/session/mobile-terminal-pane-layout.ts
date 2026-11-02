import type { TerminalSplitLayout } from '../storage/preferences'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'

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

export function terminalPaneDirection(
  frame: TerminalFrame,
  layout: TerminalSplitLayout = 'auto'
): 'row' | 'column' {
  if (layout === 'side-by-side') {
    return 'row'
  }
  if (layout === 'stacked') {
    return 'column'
  }
  return frame.width >= 600 && frame.width > frame.height ? 'row' : 'column'
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
