import type { Terminal } from '@xterm/xterm'

type LinkTapControllerOptions = {
  container: HTMLElement
  terminal: Terminal
  activateAtBufferCell: (row: number, column: number) => boolean
  cancelSelection: () => void
  onTerminalTap: () => void
}

type CompleteLinkTapOptions = {
  hasSelection: boolean
  activateLink: () => boolean
  cancelSelection: () => void
  onTerminalTap: () => void
}

type TapCandidate = {
  cell: { row: number; column: number } | null
  inputId: number
  clientX: number
  clientY: number
  hadSelection: boolean
  startedAt: number
}

const TAP_MOVE_LIMIT = 24
const TAP_DURATION_LIMIT_MS = 700
const DUPLICATE_COMPLETION_WINDOW_MS = 500

export function createTerminalWebLinkTapController({
  container,
  terminal,
  activateAtBufferCell,
  cancelSelection,
  onTerminalTap
}: LinkTapControllerOptions) {
  let lastCompletionAt = 0
  let pointerTap: TapCandidate | undefined
  let touchTap: TapCandidate | undefined

  const pointerDown = (event: PointerEvent) => {
    if (!isPrimaryTerminalWebLinkPointer(event)) {
      return
    }
    pointerTap = {
      cell: terminalBufferCellAtClientPoint(terminal, event.clientX, event.clientY),
      inputId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      hadSelection: terminal.hasSelection(),
      startedAt: Date.now()
    }
  }
  const pointerMove = (event: PointerEvent) => {
    if (
      pointerTap?.inputId === event.pointerId &&
      movedBeyondTapLimit(pointerTap, event.clientX, event.clientY)
    ) {
      pointerTap = undefined
    }
  }
  const pointerEnd = (event: PointerEvent) => {
    const candidate = pointerTap
    pointerTap = undefined
    if (touchTap) {
      return
    }
    if (!canCompleteTap(candidate, event.pointerId, terminal, lastCompletionAt)) {
      return
    }
    lastCompletionAt = Date.now()
    if (completeCandidate(candidate)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const pointerCancel = (event: PointerEvent) => {
    const candidate = pointerTap
    pointerTap = undefined
    if (touchTap) {
      return
    }
    if (!canCompleteTap(candidate, event.pointerId, terminal, lastCompletionAt)) {
      return
    }
    lastCompletionAt = Date.now()
    completeCandidate(candidate)
  }
  const touchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      touchTap = undefined
      return
    }
    const touch = event.changedTouches[0]
    if (!touch) {
      return
    }
    touchTap = {
      cell: terminalBufferCellAtClientPoint(terminal, touch.clientX, touch.clientY),
      inputId: touch.identifier,
      clientX: touch.clientX,
      clientY: touch.clientY,
      hadSelection: terminal.hasSelection(),
      startedAt: Date.now()
    }
  }
  const touchMove = (event: TouchEvent) => {
    const candidate = touchTap
    if (!candidate) {
      return
    }
    const touch = touchForIdentifier(event.touches, candidate.inputId)
    if (
      event.touches.length !== 1 ||
      !touch ||
      movedBeyondTapLimit(candidate, touch.clientX, touch.clientY)
    ) {
      touchTap = undefined
    }
  }
  const touchEnd = (event: TouchEvent) => {
    const candidate = touchTap
    touchTap = undefined
    const touch = candidate
      ? touchForIdentifier(event.changedTouches, candidate.inputId)
      : undefined
    if (!touch || !canCompleteTap(candidate, touch.identifier, terminal, lastCompletionAt)) {
      return
    }
    lastCompletionAt = Date.now()
    if (completeCandidate(candidate)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const touchCancel = (event: TouchEvent) => {
    const candidate = touchTap
    touchTap = undefined
    const touch = candidate
      ? touchForIdentifier(event.changedTouches, candidate.inputId)
      : undefined
    if (!touch || !canCompleteTap(candidate, touch.identifier, terminal, lastCompletionAt)) {
      return
    }
    lastCompletionAt = Date.now()
    completeCandidate(candidate)
  }
  const click = (event: MouseEvent) => {
    if (Date.now() - lastCompletionAt < DUPLICATE_COMPLETION_WINDOW_MS) {
      return
    }
    if (terminal.hasSelection()) {
      cancelSelection()
      return
    }
    if (completeAt(event.clientX, event.clientY, false)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const completeCandidate = (candidate: TapCandidate) => {
    return completeTerminalWebLinkTap({
      hasSelection: candidate.hadSelection,
      activateLink: () =>
        candidate.cell ? activateAtBufferCell(candidate.cell.row, candidate.cell.column) : false,
      cancelSelection,
      onTerminalTap
    })
  }
  const completeAt = (clientX: number, clientY: number, hadSelection: boolean) =>
    completeCandidate({
      cell: terminalBufferCellAtClientPoint(terminal, clientX, clientY),
      inputId: 0,
      clientX,
      clientY,
      hadSelection,
      startedAt: Date.now()
    })

  container.addEventListener('pointerdown', pointerDown, true)
  container.addEventListener('pointermove', pointerMove, true)
  container.addEventListener('pointerup', pointerEnd, true)
  container.addEventListener('pointercancel', pointerCancel, true)
  container.addEventListener('touchstart', touchStart, { capture: true, passive: true })
  container.addEventListener('touchmove', touchMove, { capture: true, passive: true })
  container.addEventListener('touchend', touchEnd, { capture: true, passive: false })
  container.addEventListener('touchcancel', touchCancel, { capture: true, passive: true })
  container.addEventListener('click', click, true)

  return {
    dispose() {
      container.removeEventListener('pointerdown', pointerDown, true)
      container.removeEventListener('pointermove', pointerMove, true)
      container.removeEventListener('pointerup', pointerEnd, true)
      container.removeEventListener('pointercancel', pointerCancel, true)
      container.removeEventListener('touchstart', touchStart, true)
      container.removeEventListener('touchmove', touchMove, true)
      container.removeEventListener('touchend', touchEnd, true)
      container.removeEventListener('touchcancel', touchCancel, true)
      container.removeEventListener('click', click, true)
    }
  }
}

function canCompleteTap(
  candidate: TapCandidate | undefined,
  inputId: number,
  terminal: Terminal,
  lastCompletionAt: number
): candidate is TapCandidate {
  if (
    !candidate ||
    candidate.inputId !== inputId ||
    Date.now() - candidate.startedAt > TAP_DURATION_LIMIT_MS ||
    Date.now() - lastCompletionAt < DUPLICATE_COMPLETION_WINDOW_MS
  ) {
    return false
  }
  return candidate.hadSelection || !terminal.hasSelection()
}

function movedBeyondTapLimit(candidate: TapCandidate, clientX: number, clientY: number): boolean {
  return Math.hypot(clientX - candidate.clientX, clientY - candidate.clientY) > TAP_MOVE_LIMIT
}

function touchForIdentifier(touches: TouchList, identifier: number): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index]
    if (touch?.identifier === identifier) {
      return touch
    }
  }
  return undefined
}

export function isPrimaryTerminalWebLinkPointer(
  event: Pick<PointerEvent, 'button' | 'pointerType'>
): boolean {
  return event.pointerType === 'touch' || event.button === 0
}

export function completeTerminalWebLinkTap({
  hasSelection,
  activateLink,
  cancelSelection,
  onTerminalTap
}: CompleteLinkTapOptions): boolean {
  if (activateLink()) {
    if (hasSelection) {
      cancelSelection()
    }
    return true
  }
  if (hasSelection) {
    cancelSelection()
  } else {
    onTerminalTap()
  }
  return false
}

function terminalBufferCellAtClientPoint(
  terminal: Terminal,
  clientX: number,
  clientY: number
): { row: number; column: number } | null {
  const element = terminal.element
  if (!element) {
    return null
  }
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null
  }
  const column = Math.max(
    0,
    Math.min(
      terminal.cols - 1,
      Math.floor((clientX - bounds.left) / (bounds.width / terminal.cols))
    )
  )
  const viewportRow = Math.max(
    0,
    Math.min(
      terminal.rows - 1,
      Math.floor((clientY - bounds.top) / (bounds.height / terminal.rows))
    )
  )
  return {
    row: terminal.buffer.active.viewportY + viewportRow,
    column
  }
}
