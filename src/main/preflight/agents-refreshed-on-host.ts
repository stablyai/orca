const agentRefreshListeners = new Set<(userInitiated: boolean) => void>()

/** An agent refresh is how a user says a CLI or its login changed; host caches drop on it. */
export function onAgentsRefreshedOnHost(listener: (userInitiated: boolean) => void): () => void {
  agentRefreshListeners.add(listener)
  return () => agentRefreshListeners.delete(listener)
}

export function notifyAgentsRefreshedOnHost(userInitiated = false): void {
  agentRefreshListeners.forEach((listener) => listener(userInitiated))
}
