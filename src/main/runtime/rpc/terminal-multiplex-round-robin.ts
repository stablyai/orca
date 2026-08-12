type TerminalMultiplexDrainStream = { streamId: number }

export function drainTerminalMultiplexRoundRobin<T extends TerminalMultiplexDrainStream>(args: {
  streams: readonly T[]
  cursorStreamId: number | null
  drainOne: (stream: T) => boolean
  canContinue?: () => boolean
}): number | null {
  const { streams, drainOne } = args
  if (streams.length === 0) {
    return null
  }
  const canContinue = args.canContinue ?? (() => true)
  let cursorStreamId = args.cursorStreamId
  let startIndex = getStartIndex(streams, cursorStreamId)
  while (canContinue()) {
    let progressed = false
    for (let offset = 0; offset < streams.length && canContinue(); offset += 1) {
      const stream = streams[(startIndex + offset) % streams.length]!
      if (drainOne(stream)) {
        cursorStreamId = stream.streamId
        progressed = true
      }
    }
    if (!progressed) {
      break
    }
    startIndex = getStartIndex(streams, cursorStreamId)
  }
  return cursorStreamId
}

function getStartIndex<T extends TerminalMultiplexDrainStream>(
  streams: readonly T[],
  cursorStreamId: number | null
): number {
  if (cursorStreamId === null) {
    return 0
  }
  return (streams.findIndex((stream) => stream.streamId === cursorStreamId) + 1) % streams.length
}
