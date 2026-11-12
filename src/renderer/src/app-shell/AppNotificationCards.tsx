import { Suspense, useEffect, type JSX } from 'react'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { CodexSharedSettingsNoticeCard } from '../components/CodexSharedSettingsNoticeCard'
import { NotificationCardStack } from '../components/NotificationCardStack'
import { StarNagCard } from '../components/StarNagCard'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import { OverlayBoundary } from './app-root-surface-boundaries'

const ChatUiHereCornerCard = lazy(() =>
  import('../components/feature-tips/ChatUiHereCornerCard').then((module) => ({
    default: module.ChatUiHereCornerCard
  }))
)
const UpdateCard = lazy(() =>
  import('../components/UpdateCard').then((module) => ({ default: module.UpdateCard }))
)
const UnexpectedSignoutCard = lazy(() =>
  import('../components/UnexpectedSignoutCard').then((module) => ({
    default: module.UnexpectedSignoutCard
  }))
)

/** A crashed card closes itself, so its open flag cannot hold other startup prompts for the session. */
function CloseCrashedCard({ onClose }: { onClose: () => void }): null {
  useEffect(() => {
    onClose()
  }, [onClose])
  return null
}

/** The bottom-right notification stack and every card that shares it. */
export function AppNotificationCards({
  activeView,
  shouldMountUpdateCard,
  chatUiHereCornerCardOpen,
  onChatUiHereCornerCardClose
}: {
  activeView: TopLevelView
  shouldMountUpdateCard: boolean
  chatUiHereCornerCardOpen: boolean
  onChatUiHereCornerCardClose: () => void
}): JSX.Element {
  return (
    <NotificationCardStack>
      {chatUiHereCornerCardOpen ? (
        <Suspense fallback={null}>
          <RecoverableRenderErrorBoundary
            boundaryId="overlay.chat-ui-here-corner-card"
            surface="overlay"
            compact
            resetKey={activeView}
            fallback={() => <CloseCrashedCard onClose={onChatUiHereCornerCardClose} />}
          >
            <ChatUiHereCornerCard onClose={onChatUiHereCornerCardClose} />
          </RecoverableRenderErrorBoundary>
        </Suspense>
      ) : null}
      {shouldMountUpdateCard ? (
        <Suspense fallback={null}>
          <OverlayBoundary boundaryId="overlay.update-card" resetKey={activeView}>
            <UpdateCard />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      <Suspense fallback={null}>
        <OverlayBoundary boundaryId="overlay.unexpected-signout" resetKey={activeView}>
          <UnexpectedSignoutCard />
        </OverlayBoundary>
      </Suspense>
      <OverlayBoundary boundaryId="overlay.star-nag" resetKey={activeView}>
        <StarNagCard />
      </OverlayBoundary>
      <OverlayBoundary boundaryId="overlay.codex-shared-settings-notice" resetKey={activeView}>
        <CodexSharedSettingsNoticeCard />
      </OverlayBoundary>
    </NotificationCardStack>
  )
}
