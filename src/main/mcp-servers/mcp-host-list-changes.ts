// Tells this host's own followers (the agent-file sync) that its MCP server list changed, beside the
// clients the runtime tells. Nothing listens until a host starts the sync, so tests write no files.
const listeners = new Set<() => void>()

export function onMcpHostListChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function noteMcpHostListChanged(): void {
  for (const listener of listeners) {
    listener()
  }
}
