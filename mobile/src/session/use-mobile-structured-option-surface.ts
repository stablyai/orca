import { useCallback, useMemo, useState, type RefObject } from 'react'
import { structuredAgentSessionShownSnapshot } from '../../../src/shared/structured-agent-session-option-view'
import type { StructuredAgentSessionOptionState } from '../../../src/shared/structured-agent-session-options'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'

/** The picker surface over a structured chat's options: picks, `/`-opened pickers, snapshots. */
export function useMobileStructuredOptionSurface(args: {
  optionSnapshot: SessionOptionDescriptor[]
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  /** The latest option state, which a settled pick's snapshot is read from. */
  optionStateRef: RefObject<StructuredAgentSessionOptionState>
}) {
  const { optionSnapshot, optionStateRef, setStructuredOption } = args
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
      return { snapshot: structuredAgentSessionShownSnapshot(optionStateRef.current) }
    },
    [optionStateRef, setStructuredOption]
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
