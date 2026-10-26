import { useCallback, useMemo, useState, type RefObject } from 'react'
import { structuredAgentSessionShownSnapshot } from '../../../src/shared/structured-agent-session-option-view'
import type { StructuredAgentSessionOptionState } from '../../../src/shared/structured-agent-session-options'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'

export function useMobileStructuredOptionSurface(args: {
  demandModelCatalog: () => void
  lockSnapshot: (snapshot: SessionOptionDescriptor[]) => SessionOptionDescriptor[]
  optionSnapshot: SessionOptionDescriptor[]
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  optionStateRef: RefObject<StructuredAgentSessionOptionState>
  projectPermission: (state: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
}) {
  const { optionSnapshot, optionStateRef, setStructuredOption, demandModelCatalog } = args
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
      return {
        snapshot: args.lockSnapshot(
          structuredAgentSessionShownSnapshot(args.projectPermission(optionStateRef.current))
        )
      }
    },
    [args.lockSnapshot, optionStateRef, setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      demandModelCatalog,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption, demandModelCatalog]
  )

  return { optionPickerRequest, invokeStructuredOption, optionSurface }
}
