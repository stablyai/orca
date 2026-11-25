import { useCallback, useRef, useState } from 'react'

// Serialize optimistic saves; refresh must not overwrite pending choices, and rejected writes must reconcile to storage.
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
          // Read back refused writes only once queued writes no longer own the screen, or the read could undo newer optimism.
          if (refused && pendingWritesRef.current === 0) {
            refresh()
          }
        })
    },
    [refresh, save]
  )

  // External writes invalidate refreshes started before they landed.
  const adoptStored = useCallback((stored: T) => {
    writeSeqRef.current += 1
    setValue(stored)
  }, [])

  return { value, setValue, persist, refresh, adoptStored }
}
