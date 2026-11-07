import { AppState, type AppStateStatus } from 'react-native'

function outsideForeground(state: AppStateStatus): boolean {
  return state === 'background' || state === 'inactive'
}

// Restart on every return to the foreground: RN fires overdue timers on resume, before a suspended WebView has had any chance to load.
export function setForegroundTimer(run: () => void, delayMs: number): () => void {
  let handle: ReturnType<typeof setTimeout> | null = null
  const pause = (): void => {
    if (handle !== null) {
      clearTimeout(handle)
      handle = null
    }
  }
  const arm = (): void => {
    handle ??= setTimeout(() => {
      handle = null
      // A fire queued behind a not-yet-delivered background change must wait for the next activation.
      if (outsideForeground(AppState.currentState)) {
        return
      }
      subscription.remove()
      run()
    }, delayMs)
  }
  const subscription = AppState.addEventListener('change', (state) => {
    if (outsideForeground(state)) {
      pause()
    } else {
      arm()
    }
  })
  if (!outsideForeground(AppState.currentState)) {
    arm()
  }
  return () => {
    pause()
    subscription.remove()
  }
}
