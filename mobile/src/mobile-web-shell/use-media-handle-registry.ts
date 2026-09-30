import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { MediaHandleRegistry } from './media-handle-registry'

/** Hoisted so the clock is a value the render hands over rather than one it reads. */
const readClock = (): number => Date.now()

/**
 * One registry per page session, swept when the session ends or the mount does.
 *
 * Keyed on the session id rather than built once per screen, because a remount mints a new one and
 * the document behind the old session is gone: nothing will ever call `release` for what it staged,
 * and the files would sit in the cache until the OS reclaimed them. The cleanup covers the unmount
 * for the same reason — a swipe away from the screen is the commonest way a pick is abandoned.
 *
 * `discard` is read through a ref so a caller's fresh closure each render cannot rebuild the
 * registry and sweep files a live page is still reading.
 */
export function useMediaHandleRegistry(args: {
  /** Null before a session is open; the registry is real either way, and simply holds nothing. */
  sessionId: string | null
  /** Deletes one staged file on this device. */
  discard: (uri: string) => void
}): MediaHandleRegistry {
  const discardRef = useRef(args.discard)
  // Commit-phase, for the reason the bridge host's callbacks are: a native frame can land between
  // a commit and a passive effect, and a discard aimed at the previous render's closure would
  // delete against a handler that is no longer mounted.
  useLayoutEffect(() => {
    discardRef.current = args.discard
  }, [args.discard])
  const registry = useMemo(
    () =>
      new MediaHandleRegistry({
        now: readClock,
        discard: (uri) => discardRef.current(uri)
      }),
    // The session id is the identity: a new one is a new document with no claim on the old files.
    [args.sessionId]
  )
  useEffect(() => () => registry.releaseAll(), [registry])
  return registry
}
