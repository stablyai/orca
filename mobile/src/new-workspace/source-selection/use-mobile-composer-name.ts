import { useCallback, useRef, useState } from 'react'
import { shouldApplyAutoName } from './composer-linked-work-item'
import type { WorkspaceSourceLinkedItem as MobileLinkedWorkItem } from '../../../../src/shared/new-workspace/workspace-source'

export function useMobileComposerName(linkedWorkItem: MobileLinkedWorkItem | null) {
  const [name, setNameState] = useState('')
  const lastAutoNameRef = useRef('')
  const setName = useCallback((value: string) => setNameState(value), [])
  const applyAutoName = useCallback(
    (suggested: string, currentName: string) => {
      if (
        suggested &&
        shouldApplyAutoName({
          currentName,
          lastAutoName: lastAutoNameRef.current,
          lookupTextIsQuery: !linkedWorkItem
        })
      ) {
        setNameState(suggested)
        lastAutoNameRef.current = suggested
      }
    },
    [linkedWorkItem]
  )
  const isNameAutoManaged = !name.trim() || name === lastAutoNameRef.current
  return { name, setName, setNameState, lastAutoNameRef, applyAutoName, isNameAutoManaged }
}
