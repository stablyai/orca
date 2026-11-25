import { Suspense, type JSX } from 'react'
import type { TopLevelView } from '../../../../shared/ui-chrome/ui-chrome-types'
import { AgentCliUpdateCard } from '../../components/agent-cli-update/AgentCliUpdateCard'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { CodexSharedSettingsNoticeCard } from '../../components/terminal-pane/provider-notices/codex-settings/CodexSharedSettingsNoticeCard'
import { NotificationCardStack } from '../../components/notifications/NotificationCardStack'
import { StarNagCard } from '../../components/star-nag/StarNagCard'
import { WorkspaceCleanupRunCard } from '../../components/workspace-cleanup/removal/run/WorkspaceCleanupRunCard'
import { OverlayBoundary } from './app-root-surface-boundaries'

const ChatUiHereCornerCard = lazy(() =>
  import('../../components/feature-tips/ChatUiHereCornerCard').then((module) => ({
    default: module.ChatUiHereCornerCard
  }))
)
const UpdateCard = lazy(() =>
  import('../../components/maintenance/update-card/UpdateCard').then((module) => ({
    default: module.UpdateCard
  }))
)
const UnexpectedSignoutCard = lazy(() =>
  import('../../components/unexpected-signout/UnexpectedSignoutCard').then((module) => ({
    default: module.UnexpectedSignoutCard
  }))
)

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
          <OverlayBoundary boundaryId="overlay.chat-ui-here-corner-card" resetKey={activeView}>
            <ChatUiHereCornerCard onClose={onChatUiHereCornerCardClose} />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      <OverlayBoundary boundaryId="overlay.agent-cli-update-card" resetKey={activeView}>
        <AgentCliUpdateCard />
      </OverlayBoundary>
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
      <OverlayBoundary boundaryId="overlay.workspace-cleanup-run" resetKey={activeView}>
        <WorkspaceCleanupRunCard />
      </OverlayBoundary>
      <OverlayBoundary boundaryId="overlay.star-nag" resetKey={activeView}>
        <StarNagCard />
      </OverlayBoundary>
      <OverlayBoundary boundaryId="overlay.codex-shared-settings-notice" resetKey={activeView}>
        <CodexSharedSettingsNoticeCard />
      </OverlayBoundary>
    </NotificationCardStack>
  )
}
