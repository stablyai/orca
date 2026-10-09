import { useCallback, useMemo, useState } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionsSurface
} from '../../../src/shared/native-chat-session-options'
import {
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'

export function useMobileStructuredOptionSurface(
  optionSnapshot: SessionOptionDescriptor[],
  optionStateRef: { current: StructuredAgentSessionOptionState },
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
) {
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const invokeStructuredOption = useCallback(
    async (id: string) => {
      if (!optionSnapshot.some((entry) => entry.id === id)) {
        return false
      }
      setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
      return true
    },
    [optionSnapshot]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: structuredAgentSessionOptionSnapshot(optionStateRef.current) }
    },
    [setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  return { optionPickerRequest, invokeStructuredOption, optionSurface }
}
