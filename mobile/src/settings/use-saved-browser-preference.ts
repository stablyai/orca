import { useCallback, useEffect, useRef, useState } from 'react'

/** A stored choice whose newest selection wins over a slower first read, and reverts when saving fails. */
export function useSavedBrowserPreference<T>(
  load: () => Promise<T>,
  save: (value: T) => Promise<void>,
  initial: T
): { value: T; select: (value: T) => void; error: 'load' | 'save' | null } {
  const [value, setValue] = useState<T>(initial)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const selectionRevision = useRef(0)
  const failedSelectionRevision = useRef<number | null>(null)
  const savedValue = useRef<T>(initial)
  const hasSaved = useRef(false)

  useEffect(() => {
    let active = true
    void load().then(
      (loaded) => {
        if (!hasSaved.current) {
          savedValue.current = loaded
        }
        if (
          active &&
          (selectionRevision.current === 0 ||
            failedSelectionRevision.current === selectionRevision.current)
        ) {
          setValue(savedValue.current)
        }
      },
      () => {
        if (active) {
          setError('load')
        }
      }
    )
    return () => {
      active = false
    }
  }, [load])

  const select = useCallback(
    (next: T) => {
      setError(null)
      const revision = ++selectionRevision.current
      setValue(next)
      void save(next).then(
        () => {
          savedValue.current = next
          hasSaved.current = true
        },
        () => {
          if (revision === selectionRevision.current) {
            failedSelectionRevision.current = revision
            setValue(savedValue.current)
            setError('save')
          }
        }
      )
    },
    [save]
  )

  return { value, select, error }
}
