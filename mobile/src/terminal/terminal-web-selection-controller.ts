import type { IBufferLine, Terminal } from '@xterm/xterm'
import type { TerminalWebViewProps } from './terminal-webview-contract'
import {
  createTerminalWebSelectionOverlay,
  positionTerminalWebSelectionOverlay,
  type TerminalWebSelectionPoint,
  type TerminalWebSelectionRange
} from './terminal-web-selection-overlay'

type SelectionControllerOptions = {
  container: HTMLElement
  terminal: Terminal
  getProps: () => TerminalWebViewProps
}

const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10
const WORD_CHARACTER = /[\p{L}\p{N}_./:@~+=?&#%-]/u

export function createTerminalWebSelectionController({
  container,
  terminal,
  getProps
}: SelectionControllerOptions) {
  const overlay = createTerminalWebSelectionOverlay()
  container.append(overlay.root)
  let selection: TerminalWebSelectionRange | null = null
  let press:
    | {
        pointerId: number
        clientX: number
        clientY: number
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  let draggedHandle: 'start' | 'end' | undefined
  let cancelling = false

  const updateOverlay = () => {
    if (!selection) {
      overlay.root.classList.remove('active')
      return
    }
    overlay.root.classList.add('active')
    positionTerminalWebSelectionOverlay(container, terminal, selection, overlay)
  }

  const applySelection = () => {
    if (!selection) {
      return
    }
    terminal.select(
      selection.start.col,
      selection.start.row,
      terminalSelectionLength(selection, terminal.cols)
    )
    updateOverlay()
  }

  const cancelSelect = () => {
    cancelling = true
    selection = null
    terminal.clearSelection()
    overlay.root.classList.remove('active')
    getProps().onSelectionMode?.(false)
    cancelling = false
  }

  const selectAll = () => {
    const buffer = terminal.buffer.active
    terminal.selectAll()
    selection = {
      start: { col: 0, row: 0 },
      end: { col: Math.max(0, terminal.cols - 1), row: Math.max(0, buffer.length - 1) }
    }
    getProps().onSelectionMode?.(true)
    updateOverlay()
  }

  const enterSelection = (clientX: number, clientY: number) => {
    const point = terminalPointAtClientPosition(terminal, clientX, clientY)
    const line = point ? terminal.buffer.active.getLine(point.row) : undefined
    if (!point || !line) {
      return
    }
    selection = terminalWordSelection(line, point)
    applySelection()
    getProps().onSelectionMode?.(true)
    getProps().onHaptic?.('selection')
  }

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || overlay.root.contains(event.target as Node)) {
      return
    }
    clearPress(press)
    press = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      timer: setTimeout(() => {
        enterSelection(event.clientX, event.clientY)
        press = undefined
      }, LONG_PRESS_MS)
    }
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (draggedHandle && selection) {
      const point = terminalPointAtClientPosition(terminal, event.clientX, event.clientY)
      if (!point) {
        return
      }
      selection = normalizeSelectionRange({
        ...selection,
        [draggedHandle]: point
      })
      applySelection()
      event.preventDefault()
      return
    }
    if (
      press?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > LONG_PRESS_SLOP
    ) {
      clearPress(press)
      press = undefined
    }
  }

  const handlePointerEnd = (event: PointerEvent) => {
    if (press?.pointerId === event.pointerId) {
      clearPress(press)
      press = undefined
    }
    draggedHandle = undefined
  }

  const startHandleDrag = (handle: 'start' | 'end', event: PointerEvent) => {
    draggedHandle = handle
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  const handleSelectionChange = terminal.onSelectionChange(() => {
    if (selection && !terminal.hasSelection() && !cancelling) {
      selection = null
      overlay.root.classList.remove('active')
      getProps().onSelectionEvicted?.()
      getProps().onSelectionMode?.(false)
    }
  })
  const handleResize = terminal.onResize(updateOverlay)
  const handleScroll = terminal.onScroll(updateOverlay)
  const copy = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    const text = terminal.getSelection()
    if (text) {
      getProps().onSelectionCopy?.(text)
    } else {
      cancelSelect()
    }
  }
  const selectEverything = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    selectAll()
  }
  const startDrag = (event: Event) => startHandleDrag('start', event as unknown as PointerEvent)
  const endDrag = (event: Event) => startHandleDrag('end', event as unknown as PointerEvent)

  container.addEventListener('pointerdown', handlePointerDown, true)
  container.addEventListener('pointermove', handlePointerMove, true)
  container.addEventListener('pointerup', handlePointerEnd, true)
  container.addEventListener('pointercancel', handlePointerEnd, true)
  overlay.copy.addEventListener('click', copy)
  overlay.selectAll.addEventListener('click', selectEverything)
  overlay.start.addEventListener('pointerdown', startDrag)
  overlay.end.addEventListener('pointerdown', endDrag)

  return {
    cancelSelect,
    selectAll,
    dispose() {
      clearPress(press)
      handleSelectionChange.dispose()
      handleResize.dispose()
      handleScroll.dispose()
      container.removeEventListener('pointerdown', handlePointerDown, true)
      container.removeEventListener('pointermove', handlePointerMove, true)
      container.removeEventListener('pointerup', handlePointerEnd, true)
      container.removeEventListener('pointercancel', handlePointerEnd, true)
      overlay.copy.removeEventListener('click', copy)
      overlay.selectAll.removeEventListener('click', selectEverything)
      overlay.start.removeEventListener('pointerdown', startDrag)
      overlay.end.removeEventListener('pointerdown', endDrag)
      overlay.root.remove()
    }
  }
}

export function terminalSelectionLength(range: TerminalWebSelectionRange, cols: number): number {
  return Math.max(1, (range.end.row - range.start.row) * cols + range.end.col - range.start.col + 1)
}

export function terminalWordSelection(
  line: IBufferLine,
  point: TerminalWebSelectionPoint
): TerminalWebSelectionRange {
  let start = point.col
  let end = point.col
  while (start > 0 && isWordCell(line, start - 1)) {
    start -= 1
  }
  while (end + 1 < line.length && isWordCell(line, end + 1)) {
    end += 1
  }
  return {
    start: { col: start, row: point.row },
    end: { col: end, row: point.row }
  }
}

function normalizeSelectionRange(range: TerminalWebSelectionRange): TerminalWebSelectionRange {
  if (
    range.start.row < range.end.row ||
    (range.start.row === range.end.row && range.start.col <= range.end.col)
  ) {
    return range
  }
  return { start: range.end, end: range.start }
}

function isWordCell(line: IBufferLine, col: number): boolean {
  const characters = line.getCell(col)?.getChars() ?? ''
  return characters.length > 0 && WORD_CHARACTER.test(characters)
}

function terminalPointAtClientPosition(
  terminal: Terminal,
  clientX: number,
  clientY: number
): TerminalWebSelectionPoint | null {
  const element = terminal.element
  if (!element) {
    return null
  }
  const bounds = element.getBoundingClientRect()
  const cellWidth = bounds.width / terminal.cols
  const cellHeight = bounds.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null
  }
  const col = Math.max(
    0,
    Math.min(terminal.cols - 1, Math.floor((clientX - bounds.left) / cellWidth))
  )
  const viewportRow = Math.max(
    0,
    Math.min(terminal.rows - 1, Math.floor((clientY - bounds.top) / cellHeight))
  )
  return { col, row: terminal.buffer.active.viewportY + viewportRow }
}

function clearPress(press: { timer: ReturnType<typeof setTimeout> } | undefined): void {
  if (press) {
    clearTimeout(press.timer)
  }
}
