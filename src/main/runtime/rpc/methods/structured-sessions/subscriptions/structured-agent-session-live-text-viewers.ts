// A viewer's word on whether it is shown reaches each of its streams of the chat. Its id is random
// per read, so only the client that opened the streams can name them.
// Reports can arrive out of order (a remote desktop's calls take separate sockets), so each carries
// the viewer's sequence and an older one than a stream last took is ignored.
type ViewerStream = { set: (shown: boolean) => void; seq: number }
const viewers = new Map<string, Set<ViewerStream>>()

export const liveTextViewerKey = (sessionId: string, viewerId: string): string =>
  `${sessionId}:${viewerId}`

/** Registers one stream's setter under its viewer, from the report its open carried, until the
 *  stream closes. */
export function registerLiveTextViewer(
  viewer: string,
  seq: number,
  set: (shown: boolean) => void
): () => void {
  const streams = viewers.get(viewer) ?? new Set()
  const stream = { set, seq }
  streams.add(stream)
  viewers.set(viewer, streams)
  return () => {
    streams.delete(stream)
    if (streams.size === 0 && viewers.get(viewer) === streams) {
      viewers.delete(viewer)
    }
  }
}

/** A viewer says it is shown or hidden; a viewer with no open stream has nothing to change. */
export function setLiveTextViewerShown(viewer: string, shown: boolean, seq: number): void {
  viewers.get(viewer)?.forEach((stream) => {
    if (seq > stream.seq) {
      stream.seq = seq
      stream.set(shown)
    }
  })
}
