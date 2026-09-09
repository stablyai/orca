import type { BrowserWindow } from 'electron'

type MainWindowDisposer = () => void

interface MainWindowCloseState {
  closed: boolean
  disposers: Set<MainWindowDisposer>
}

const closeStates = new WeakMap<BrowserWindow, MainWindowCloseState>()

function getCloseState(mainWindow: BrowserWindow): MainWindowCloseState {
  const existing = closeStates.get(mainWindow)
  if (existing) {
    return existing
  }

  const state: MainWindowCloseState = { closed: false, disposers: new Set() }
  closeStates.set(mainWindow, state)
  // One native listener owns the close fan-out. Subsystems register plain disposers below.
  mainWindow.once('closed', () => {
    state.closed = true
    const disposers = [...state.disposers]
    state.disposers.clear()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        console.error('[window] Main-window close disposer failed', error)
      }
    }
  })
  return state
}

/** Register cleanup without adding another native BrowserWindow `closed` listener. */
export function registerMainWindowCloseDisposer(
  mainWindow: BrowserWindow,
  dispose: MainWindowDisposer
): () => void {
  const state = getCloseState(mainWindow)
  if (state.closed) {
    dispose()
    return () => {}
  }
  state.disposers.add(dispose)
  return () => state.disposers.delete(dispose)
}

export function getMainWindowNativeCloseListenerBudget(mainWindow: BrowserWindow): number {
  getCloseState(mainWindow)
  return mainWindow.listenerCount('closed')
}
