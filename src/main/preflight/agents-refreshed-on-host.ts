const agentRefreshListeners = new Set<() => void>()

/** An agent refresh is how a user says a CLI or its login changed; host caches drop on it. */
export function onAgentsRefreshedOnHost(listener: () => void): () => void {
  agentRefreshListeners.add(listener)
  return () => agentRefreshListeners.delete(listener)
}

export function notifyAgentsRefreshedOnHost(): void {
  agentRefreshListeners.forEach((listener) => listener())
}
