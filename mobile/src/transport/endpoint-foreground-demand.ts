// Keep lifecycle callers independent of RN types.
type ForegroundAppState = {
  currentState: string
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void }
}

type EndpointForegroundDemandArgs = {
  appState: ForegroundAppState
  isKeepAliveActive: () => boolean
  subscribeKeepAlive: (listener: () => void) => () => void
  apply: (foreground: boolean) => void
}

/**
 * Drives an endpoint lifecycle's foreground flag: true while the app is active or a background
 * keep-alive holds it. Applies the first value, then only changes, because re-entering
 * setForeground(true) probes and can suspend a healthy relay.
 */
export function startEndpointForegroundDemand({
  appState,
  isKeepAliveActive,
  subscribeKeepAlive,
  apply
}: EndpointForegroundDemandArgs): () => void {
  let appActive = appState.currentState === 'active'
  let applied: boolean | null = null
  const evaluate = (): void => {
    const next = appActive || isKeepAliveActive()
    if (next === applied) {
      return
    }
    applied = next
    apply(next)
  }
  // Read the state from the event, as the inline listener this replaces did.
  const subscription = appState.addEventListener('change', (state) => {
    appActive = state === 'active'
    evaluate()
  })
  const unsubscribe = subscribeKeepAlive(evaluate)
  evaluate()
  return () => {
    subscription.remove()
    unsubscribe()
  }
}
