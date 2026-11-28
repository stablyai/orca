// A read of the phone's shared agents, now (once they are loaded) and again on each change that
// alters it.
type Source = { ready: () => Promise<void>; onChanged: (listener: () => void) => () => void }

export function watchPhoneSharedAgents<T>(
  agents: Source,
  read: () => T,
  onValue: (value: T) => void
): () => void {
  let last: string | null = null
  const emit = () => {
    const value = read()
    const seen = JSON.stringify(value)
    if (seen !== last) {
      last = seen
      onValue(value)
    }
  }
  let stopped = false
  const stop = agents.onChanged(emit)
  void agents.ready().then(() => !stopped && emit())
  return () => {
    stopped = true
    stop()
  }
}
