import { useMemo, useSyncExternalStore } from 'react'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import { EMPTY_PAGE_GEOMETRY } from '../mobile-web-shell/bridge/bridge-page-geometry'

export function usePageGeometry() {
  const client = usePageBridgeClientIfPresent()
  return useSyncExternalStore(
    client?.onPageGeometryUpdate ?? (() => () => undefined),
    () => client?.getShellSession()?.pageGeometry ?? EMPTY_PAGE_GEOMETRY
  )
}
export function useReservedRegions() {
  const { occlusions } = usePageGeometry()
  return useMemo(() => ({ divisions: [], occlusions }), [occlusions])
}
