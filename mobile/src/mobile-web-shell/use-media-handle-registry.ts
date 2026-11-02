import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { MediaHandleRegistry } from './media-handle-registry'

const readClock = (): number => Date.now()

// Own files per session and sweep on replacement/unmount because abandoned documents cannot release them. Read discard through a ref so fresh closures cannot sweep a live page’s files.
export function useMediaHandleRegistry(args: {
  sessionId: string | null
  discard: (uri: string) => void
}): MediaHandleRegistry {
  const discardRef = useRef(args.discard)
  // Update on commit before passive effects: a native frame in that gap must use the current discard handler.
  useLayoutEffect(() => {
    discardRef.current = args.discard
  }, [args.discard])
  const registry = useMemo(
    () =>
      new MediaHandleRegistry({
        now: readClock,
        discard: (uri) => discardRef.current(uri)
      }),
    [args.sessionId]
  )
  useEffect(() => () => registry.releaseAll(), [registry])
  return registry
}
