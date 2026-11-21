// A viewer's word on whether it is shown reaches each of its streams of the chat. Its id is random
// per read, so only the client that opened the streams can name them.
const viewers = new Map<string, Set<(shown: boolean) => void>>()

export const liveTextViewerKey = (sessionId: string, viewerId: string): string =>
  `${sessionId}:${viewerId}`

/** Registers one stream's setter under its viewer, until the stream closes. */
export function registerLiveTextViewer(viewer: string, set: (shown: boolean) => void): () => void {
  const streams = viewers.get(viewer) ?? new Set()
  streams.add(set)
  viewers.set(viewer, streams)
  return () => {
    streams.delete(set)
    if (streams.size === 0 && viewers.get(viewer) === streams) {
      viewers.delete(viewer)
    }
  }
}

/** A viewer says it is shown or hidden; a viewer with no open stream has nothing to change. */
export function setLiveTextViewerShown(viewer: string, shown: boolean): void {
  viewers.get(viewer)?.forEach((set) => set(shown))
}
