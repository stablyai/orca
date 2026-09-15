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
