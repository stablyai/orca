import { useCallback, useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MobileDiffReviewScreenView } from '../components/MobileDiffReviewScreenView'
import { firstReviewParam, normalizeReviewFilterParam } from './mobile-diff-review-screen-model'
import { normalizeReviewAreaParam } from './mobile-diff-review-positioning'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'

/**
 * The review screen as a component rather than a route module: the page's route file mounts it, and
 * the native route file, which mounts the shell, cannot be imported by the page. It reads its own
 * params.
 */
export function MobileDiffReviewRouteScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    scope?: string | string[]
    file?: string | string[]
    area?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const name = firstReviewParam(params.name)
  const initialFilter = normalizeReviewFilterParam(firstReviewParam(params.scope))
  const initialFile = firstReviewParam(params.file)
  const initialArea = normalizeReviewAreaParam(firstReviewParam(params.area))
  const initialTarget = useMemo(
    () => (initialFile && initialArea ? { filePath: initialFile, area: initialArea } : null),
    [initialArea, initialFile]
  )
  // Not `useRouter`: inside the shell's page the session screen is native, so that replace has to
  // be handed back to the app rather than posted into a document that does not render it.
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
    onOpenSession: openSession,
    onReconnect: forceReconnect
  })

  return <MobileDiffReviewScreenView controller={controller} onBack={() => router.back()} />
}
