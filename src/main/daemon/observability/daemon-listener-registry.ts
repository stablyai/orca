export function removeDaemonListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener)
  if (index !== -1) {
    listeners.splice(index, 1)
  }
}

export function notifyDaemonAuditListeners<T>(
  listeners: readonly ((value: T) => void)[],
  value: T
): void {
  for (const listener of listeners.slice()) {
    try {
      listener(value)
    } catch {
      // Audit observers cannot affect daemon operations.
    }
  }
}
