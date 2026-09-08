import type { Terminal } from '@xterm/xterm'

export type TerminalWebSelectionPoint = {
  col: number
  row: number
}

export type TerminalWebSelectionRange = {
  start: TerminalWebSelectionPoint
  end: TerminalWebSelectionPoint
}

export function positionTerminalWebSelectionOverlay(
  container: HTMLElement,
  terminal: Terminal,
  range: TerminalWebSelectionRange,
  overlay: ReturnType<typeof createTerminalWebSelectionOverlay>
): void {
  const terminalBounds = terminal.element?.getBoundingClientRect()
  const containerBounds = container.getBoundingClientRect()
  if (!terminalBounds || terminalBounds.width <= 0 || terminalBounds.height <= 0) {
    return
  }
  const cellWidth = terminalBounds.width / terminal.cols
  const cellHeight = terminalBounds.height / terminal.rows
  const viewportY = terminal.buffer.active.viewportY
  const startX = terminalBounds.left - containerBounds.left + range.start.col * cellWidth
  const startY =
    terminalBounds.top - containerBounds.top + (range.start.row - viewportY) * cellHeight
  const endX = terminalBounds.left - containerBounds.left + (range.end.col + 1) * cellWidth
  const endY =
    terminalBounds.top - containerBounds.top + (range.end.row - viewportY + 1) * cellHeight
  overlay.start.style.left = `${startX}px`
  overlay.start.style.top = `${startY}px`
  overlay.end.style.left = `${endX}px`
  overlay.end.style.top = `${endY}px`
  const menuWidth = overlay.menu.offsetWidth || 148
  const menuLeft = Math.max(
    8,
    Math.min(containerBounds.width - menuWidth - 8, startX - menuWidth / 2)
  )
  overlay.menu.style.left = `${menuLeft}px`
  overlay.menu.style.top = `${startY > 56 ? startY - 12 : endY + 12}px`
  overlay.menu.style.transform = startY > 56 ? 'translateY(-100%)' : 'none'
}

export function createTerminalWebSelectionOverlay() {
  const root = document.createElement('div')
  root.className = 'orca-terminal-selection'
  root.innerHTML = `
    <style>
      .orca-terminal-selection { position:absolute;inset:0;pointer-events:none;z-index:10;display:none }
      .orca-terminal-selection.active { display:block }
      .orca-terminal-selection-handle { position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;pointer-events:auto;touch-action:none }
      .orca-terminal-selection-handle::before { content:'';position:absolute;left:50%;width:14px;height:14px;transform:translateX(-50%);background:#7aa2f7;border:2px solid #c0caf5;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.5) }
      .orca-terminal-selection-handle.start::before { top:8px }
      .orca-terminal-selection-handle.end::before { top:22px }
      .orca-terminal-selection-menu { position:absolute;display:flex;overflow:hidden;pointer-events:auto;background:#2a2f4a;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.5);user-select:none }
      .orca-terminal-selection-menu button { padding:10px 16px;border:0;background:transparent;color:#c0caf5;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
      .orca-terminal-selection-menu button:active { background:#414868 }
      .orca-terminal-selection-menu button + button { border-left:1px solid #414868 }
    </style>
    <div class="orca-terminal-selection-handle start"></div>
    <div class="orca-terminal-selection-handle end"></div>
    <div class="orca-terminal-selection-menu"><button>Copy</button><button>Select All</button></div>
  `
  const handles = root.querySelectorAll<HTMLElement>('.orca-terminal-selection-handle')
  const buttons = root.querySelectorAll<HTMLButtonElement>('button')
  return {
    root,
    start: handles[0]!,
    end: handles[1]!,
    menu: root.querySelector<HTMLElement>('.orca-terminal-selection-menu')!,
    copy: buttons[0]!,
    selectAll: buttons[1]!
  }
}
