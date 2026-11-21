import { useEffect, useState } from 'react'
import { useShellStorage } from '../../../platform/shell-storage/shell-storage'
import {
  persistMirrored,
  readMirroredKeyOrStore,
  subscribeMirroredKey
} from '../../../storage/mirrored-storage-keys'

const key = 'orca:composerAgentIconPosition'
export type ComposerAgentIconPosition = 'model' | 'field' | 'off'

function position(raw: string | null | undefined): ComposerAgentIconPosition {
  return raw === 'field' || raw === 'off' ? raw : 'model'
}

let writes = Promise.resolve()
export function setComposerAgentIconPosition(value: ComposerAgentIconPosition): void {
  writes = writes
    .then(() => persistMirrored(key, value))
    .catch((error: unknown) => {
      console.warn('Could not save the composer agent icon position', error)
    })
}

export function useComposerAgentIconPosition(): ComposerAgentIconPosition {
  const shell = useShellStorage()
  const [saved, setSaved] = useState<ComposerAgentIconPosition>('model')
  const embedded = shell !== null
  useEffect(() => {
    if (embedded) {
      return
    }
    let acceptRead = true
    const unsubscribe = subscribeMirroredKey(key, (raw) => {
      acceptRead = false
      setSaved(position(raw))
    })
    void readMirroredKeyOrStore(key)
      .then((raw) => {
        if (acceptRead) {
          setSaved(position(raw))
        }
      })
      .catch((error: unknown) =>
        console.warn('Could not load the composer agent icon position', error)
      )
    return () => {
      acceptRead = false
      unsubscribe()
    }
  }, [embedded])
  return shell === null ? saved : position(shell[key])
}
