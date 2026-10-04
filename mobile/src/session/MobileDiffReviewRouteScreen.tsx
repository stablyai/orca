import { useCallback, useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { MobileDiffReviewScreenView } from '../components/MobileDiffReviewScreenView'
import { firstReviewParam, normalizeReviewFilterParam } from './mobile-diff-review-screen-model'
import { normalizeReviewAreaParam } from './mobile-diff-review-positioning'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { useRouteHandoff } from '../navigation/route-handoff'

/**
 * The review screen as a component rather than a route module, which is what lets a switch hold it.
 *
 * A route file that both reads the flag and calls `useMobileDiffReviewController` runs the whole
 * controller — its client subscriptions included — behind the page, because hooks cannot be
 * conditional. As an element passed for `fallback` it is created and not mounted, so the
 * controller runs only when the shell answers `native-route`. Same reason the explorer switch
 * builds its panel as an element.
 *
 * The params are read here rather than handed down, so this is the route body and the two route
 * files above it are the switch and its web sibling.
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
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
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
