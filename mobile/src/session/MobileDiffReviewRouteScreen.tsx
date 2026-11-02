import { useCallback, useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MobileDiffReviewScreenView } from '../components/MobileDiffReviewScreenView'
import { firstReviewParam } from './mobile-diff-review-screen-model'
import { normalizeReviewAreaParam, scopeForTargetArea } from './mobile-diff-review-positioning'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'

// Keep the screen importable by the page: native route modules mount the shell.
export function MobileDiffReviewRouteScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    file?: string | string[]
    area?: string | string[]
    commit?: string | string[]
    line?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const name = firstReviewParam(params.name)
  const initialFile = firstReviewParam(params.file)
  const initialArea = normalizeReviewAreaParam(firstReviewParam(params.area))
  const initialFilter = initialArea ? scopeForTargetArea(initialArea) : 'all'
  const commitOid = firstReviewParam(params.commit) || null
  const lineParam = Number.parseInt(firstReviewParam(params.line), 10)
  const initialLine = Number.isInteger(lineParam) && lineParam > 0 ? lineParam : null
  const initialTarget = useMemo(
    () => (initialFile && initialArea ? { filePath: initialFile, area: initialArea } : null),
    [initialArea, initialFile]
  )
  // Hand session replacement to native because this page does not render that route.
  const router = useWorkspaceRouteHandoff()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()

  const openSession = useCallback(() => {
    const query = name ? `?${new URLSearchParams({ name }).toString()}` : ''
    router.replace(
      `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${query}`
    )
  }, [hostId, name, router, worktreeId])

  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const controller = useMobileDiffReviewController({
    client,
    connState,
    hostCapabilities,
    hostStatusPending: statusPending,
    hostStatusReadable: statusReadable,
    hostId,
    worktreeId,
    name,
    initialFilter,
    initialTarget,
    commitOid,
    initialLine,
    onOpenSession: openSession,
    onReconnect: forceReconnect
  })

  return <MobileDiffReviewScreenView controller={controller} onBack={() => router.back()} />
}
