import { keepsTerminalPaneVisible } from './mobile-terminal-pane-layout'

type ActiveSurface = { type: string; terminal?: string | null } | null

export function applyActiveTerminalHandle(input: {
  active: ActiveSurface
  activeHandleRef: { current: string | null }
  visible: readonly string[] | undefined
  setActiveHandle: (handle: string | null) => void
  subscribe: (handle: string) => void
  unsubscribe: (handle: string) => void
}): void {
  const previous = input.activeHandleRef.current
  const release = (next: string | null) => {
    if (previous && previous !== next && !keepsTerminalPaneVisible(previous, input.visible)) {
      input.unsubscribe(previous)
    }
  }
  if (input.active?.type === 'terminal') {
    if (typeof input.active.terminal !== 'string') {
      release(null)
      input.activeHandleRef.current = null
      input.setActiveHandle(null)
      return
    }
    release(input.active.terminal)
    input.activeHandleRef.current = input.active.terminal
    input.setActiveHandle(input.active.terminal)
    input.subscribe(input.active.terminal)
    return
  }
  if (input.active) {
    // Transient empty snapshots may omit a live terminal; only an explicit close clears it.
    release(null)
    input.activeHandleRef.current = null
    input.setActiveHandle(null)
  }
}
