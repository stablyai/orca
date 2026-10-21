import { useCallback, useRef, useState } from 'react'

/**
 * Screen state over a stored value, changed optimistically and saved one write at a time.
 *
 * A focus or AppState refresh that races an in-flight save must not overwrite the optimistic
 * state, and a refused save must not leave the screen showing a change the store never took.
 */
export function useSerializedStoredState<T>(
  initial: T | (() => T),
  load: () => Promise<T>,
  save: (value: T) => Promise<void>
) {
  const [value, setValue] = useState(initial)
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  const writeSeqRef = useRef(0)
  const pendingWritesRef = useRef(0)

  const refresh = useCallback(() => {
    const refreshSeq = writeSeqRef.current
    void load().then((stored) => {
      if (pendingWritesRef.current > 0 || refreshSeq !== writeSeqRef.current) {
        return
      }
      setValue(stored)
    })
  }, [load])

  const persist = useCallback(
    (next: T) => {
      writeSeqRef.current += 1
      pendingWritesRef.current += 1
      writeChainRef.current = writeChainRef.current
        .then(() => save(next))
        .then(
          () => false,
          () => true
        )
        .then((refused) => {
          pendingWritesRef.current -= 1
          // Why: a refused write left the store as it was; show what it holds. A write still
          // queued owns the screen, and a read started now could land after it and undo it.
          if (refused && pendingWritesRef.current === 0) {
            refresh()
          }
        })
    },
    [refresh, save]
  )

  /** A value another writer already stored; refreshes that read before it landed are dropped. */
  const adoptStored = useCallback((stored: T) => {
    writeSeqRef.current += 1
    setValue(stored)
  }, [])

  return { value, setValue, persist, refresh, adoptStored }
}
