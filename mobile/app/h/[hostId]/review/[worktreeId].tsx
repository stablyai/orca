import { useCallback, useMemo } from 'react'
import { useRouter } from 'expo-router'
import { MobileDiffReviewScreenView } from '../../../../src/components/MobileDiffReviewScreenView'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'
import {
  firstReviewParam,
  normalizeReviewFilterParam
} from '../../../../src/session/mobile-diff-review-screen-model'
import { normalizeReviewAreaParam } from '../../../../src/session/mobile-diff-review-positioning'
import { useMobileDiffReviewController } from '../../../../src/session/use-mobile-diff-review-controller'
import type { HostDiffReviewBinding } from '../../../../src/session/host-diff-review-binding'
import { useHostDiffReviewBinding } from '../../../../src/session/use-host-diff-review-binding'

export function MobileDiffReviewRoute({
  binding,
  routeName
}: {
  binding?: HostDiffReviewBinding
  routeName?: string
} = {}) {
  const params = useMobileWebRouteParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    scope?: string | string[]
    file?: string | string[]
    area?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const name = routeName ?? firstReviewParam(params.name)
  const initialFilter = normalizeReviewFilterParam(firstReviewParam(params.scope))
  const initialFile = firstReviewParam(params.file)
  const initialArea = normalizeReviewAreaParam(firstReviewParam(params.area))
  const initialTarget = useMemo(
    () => (initialFile && initialArea ? { filePath: initialFile, area: initialArea } : null),
    [initialArea, initialFile]
  )
  const router = useRouter()
  const host = useHostDiffReviewBinding(hostId, binding)

  const openSession = useCallback(() => {
    const query = name ? `?${new URLSearchParams({ name }).toString()}` : ''
    router.replace(
      `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${query}`
    )
  }, [hostId, name, router, worktreeId])

  const controller = useMobileDiffReviewController({
    client: host.client,
    connState: host.connectionState,
    hostId,
    worktreeId,
    name,
    initialFilter,
    initialTarget,
    onOpenSession: openSession,
    onReconnect: host.reconnect,
    device: host.device
  })

  return <MobileDiffReviewScreenView controller={controller} onBack={() => router.back()} />
}

export default function MobileDiffReviewScreen() {
  return <MobileDiffReviewRoute />
}
