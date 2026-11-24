// A chat's last viewer (a desktop or phone with it open) left. Bots listen, so a finished run chat
// kept open while someone read it counts down again.
type ViewerLeftListener = (sessionId: string) => void

const listeners = new Set<ViewerLeftListener>()

export function onAgentSessionViewerLeft(listener: ViewerLeftListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteAgentSessionViewerLeft(sessionId: string): void {
  for (const listener of listeners) {
    listener(sessionId)
  }
}
