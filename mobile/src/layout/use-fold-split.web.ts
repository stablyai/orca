import { useSyncExternalStore } from 'react'
import { useWindowDimensions } from 'react-native'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { FoldSplit } from './fold-division'

/** The fold the shell measured over this page, in the page's px; null when none splits it. */
export function useFoldSplit(): FoldSplit | null {
  const client = usePageBridgeClient()
  const division = useSyncExternalStore(
    client.onFoldDivisionUpdate,
    () => client.getShellSession()?.foldDivision ?? null
  )
  const { width, height } = useWindowDimensions()
  if (division === null) {
    return null
  }
  return { ...division, size: division.axis === 'vertical' ? width : height }
}
