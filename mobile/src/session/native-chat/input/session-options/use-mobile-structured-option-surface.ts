import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

export function useMobileStructuredOptionSurface(args: {
  admits: NonNullable<SessionOptionsSurface['admits']>
  demandModelCatalog: () => void
  optionSnapshot: SessionOptionDescriptor[]
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  readOptionSnapshot: () => SessionOptionDescriptor[]
}) {
  const { admits, optionSnapshot, readOptionSnapshot, setStructuredOption, demandModelCatalog } =
    args
  const snapshotRef = useRef(readOptionSnapshot)
  useLayoutEffect(() => {
    snapshotRef.current = readOptionSnapshot
  }, [readOptionSnapshot])
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
      return { snapshot: snapshotRef.current() }
    },
    [setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      admits,
      demandModelCatalog,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption, demandModelCatalog, admits]
  )

  return { optionPickerRequest, invokeStructuredOption, optionSurface }
}
