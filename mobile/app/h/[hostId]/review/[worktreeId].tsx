import { useCallback } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MobileDiffReviewScreenView } from '../../../../src/components/MobileDiffReviewScreenView'
import {
  firstReviewParam,
  normalizeReviewFilterParam
} from '../../../../src/session/mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from '../../../../src/session/use-mobile-diff-review-controller'
import { useForceReconnect, useHostClient } from '../../../../src/transport/client-context'

export default function MobileDiffReviewScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    scope?: string | string[]
  }>()
  const hostId = firstReviewParam(params.hostId)
  const worktreeId = firstReviewParam(params.worktreeId)
  const name = firstReviewParam(params.name)
  const initialFilter = normalizeReviewFilterParam(firstReviewParam(params.scope))
  const router = useRouter()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()

  const openSession = useCallback(() => {
    const query = name ? `?${new URLSearchParams({ name }).toString()}` : ''
    router.replace(
      `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}${query}`
    )
  }, [hostId, name, router, worktreeId])

  const controller = useMobileDiffReviewController({
    client,
    connState,
    hostId,
    worktreeId,
    name,
    initialFilter,
    onOpenSession: openSession,
    onReconnect: forceReconnect
  })

  return <MobileDiffReviewScreenView controller={controller} onBack={() => router.back()} />
}
