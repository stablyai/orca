import { ModalBoundary, OverlayBoundary } from './app-root-surface-boundaries'
import { OnboardingLanguageLoading } from '../components/onboarding/OnboardingLanguageLoading'
import { useLanguageReadiness } from '../i18n/language-readiness'
import { NotificationCardStack } from '../components/NotificationCardStack'
import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { translate } from '@/i18n/i18n'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import NewWorkspaceComposerModal from '../components/NewWorkspaceComposerModal'
import { CrashReportDialog } from '../components/crash-report/CrashReportDialog'
import { MarkdownTemplatePicker } from '../components/editor/MarkdownTemplatePicker'
import RecentTabSwitcher from '../components/tab-bar/RecentTabSwitcher'
import { SkillFreshnessUpdateDialog } from '../components/skills/SkillFreshnessUpdateDialog'
import { StarNagCard } from '../components/StarNagCard'
import { NativeChatResumeOnRestartModal } from '../components/NativeChatResumeRuntimeModal'
import { StarNagAgentValueMomentObserver } from '../components/star-nag/StarNagAgentValueMomentObserver'
import { StarNagToastHost } from '../components/star-nag/StarNagToastHost'
import { TelemetryFirstLaunchSurface } from '../components/TelemetryFirstLaunchSurface'
import { ZoomOverlay } from '../components/ZoomOverlay'
import { WslMoveDialogHost } from '../components/wsl-move/WslMoveDialog'
import { shouldRenderPetOverlay } from '../components/pet/pet-overlay-visibility'
import { useAppStore } from '../store'
import type { UpdateStatus } from '../../../shared/update-status-types'
import { useLazyModalMounts } from './use-lazy-modal-mounts'
import { usePreloadWorktreeJumpPalette, WorktreeJumpPalette } from './worktree-jump-palette-preload'
import {
  selectAppRootSurfacePetEnabled,
  selectAppRootSurfaceTelemetryOptedIn,
  selectAppRootSurfaceVoiceEnabled
} from './app-root-surface-settings'
import type { FloatingWorkspacePanelState } from './use-floating-workspace-panel'
import type { OnboardingGate } from './use-onboarding-and-feature-tips'

const QuickOpen = lazy(() => import('../components/QuickOpen'))
const WorkspaceCleanupDialog = lazy(
  () => import('../components/workspace-cleanup/WorkspaceCleanupDialog')
)
const StatusBar = lazy(() =>
  import('../components/status-bar/StatusBar').then((module) => ({ default: module.StatusBar }))
)
const SetupGuideModal = lazy(() => import('../components/setup-guide/SetupGuideModal'))
const FeatureWallModal = lazy(() => import('../components/feature-wall/FeatureWallModal'))
const FeatureTipsModal = lazy(() => import('../components/feature-tips/FeatureTipsModal'))
const AddRepoDialog = lazy(() => import('../components/sidebar/AddRepoDialog'))
const NonGitFolderDialog = lazy(() => import('../components/sidebar/NonGitFolderDialog'))
const AddProjectFromFolderDialog = lazy(
  () => import('../components/sidebar/AddProjectFromFolderDialog')
)
const DiagramViewerModal = lazy(() => import('../components/editor/DiagramViewerModal'))
const ProjectAddedDialog = lazy(() => import('../components/sidebar/ProjectAddedDialog'))
const NodeDistMirrorDialog = lazy(() => import('../components/settings/NodeDistMirrorDialog'))
const AiVaultSessionHistoryDialog = lazy(
  () => import('../components/right-sidebar/AiVaultSessionHistoryDialog')
)
const DeleteWorktreeDialog = lazy(() => import('../components/sidebar/DeleteWorktreeDialog'))
const PreservedBranchBatchReviewModal = lazy(
  () => import('../components/sidebar/PreservedBranchBatchReviewModal')
)
const DictationController = lazy(() =>
  import('../components/dictation/DictationController').then((module) => ({
    default: module.DictationController
  }))
)
const SshPassphraseDialog = lazy(() =>
  import('../components/settings/SshPassphraseDialog').then((module) => ({
    default: module.SshPassphraseDialog
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
const RemoteServerUpdateDialog = lazy(
  () => import('../components/settings/RemoteServerUpdateDialog')
)
const ContextualTourOverlay = lazy(() =>
  import('../components/contextual-tours/ContextualTourOverlay').then((module) => ({
    default: module.ContextualTourOverlay
  }))
)
const SetupGuideTelemetryObserver = lazy(() =>
  import('../components/setup-guide/SetupGuideTelemetryObserver').then((module) => ({
    default: module.SetupGuideTelemetryObserver
  }))
)
const FloatingTerminalPanel = lazy(() =>
  import('../components/floating-terminal/FloatingTerminalPanel').then((module) => ({
    default: module.FloatingTerminalPanel
  }))
)
// Load the pet asset/overlay only when enabled.
const PetOverlay = lazy(() => import('../components/pet/PetOverlay'))
// Avoid fetching onboarding assets for users past first launch.
const OnboardingFlow = lazy(() => import('../components/onboarding/OnboardingFlow'))

function shouldMountUpdateCardForStatus(status: UpdateStatus): boolean {
  if (status.state === 'idle') {
    return false
  }
  if (status.state === 'checking' || status.state === 'not-available') {
    return status.userInitiated === true
  }
  return true
}

/** Keep root overlays in stable sibling order; fetch gated chunks only when their surfaces can appear. */
export function AppRootSurfaces(props: {
  floatingWorkspace: FloatingWorkspacePanelState
  onboardingGate: OnboardingGate
}): React.JSX.Element {
  const { floatingWorkspace, onboardingGate } = props
  const languageReady = useLanguageReadiness((state) => state.ready)
  const { mountedLazyModalIds, shouldMountAddRepoDialog } = useLazyModalMounts()
  usePreloadWorktreeJumpPalette()
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  // Subscribe only to consumed settings so unrelated preferences cannot rerender every overlay.
  const voiceEnabled = useAppStore(selectAppRootSurfaceVoiceEnabled)
  const petEnabled = useAppStore(selectAppRootSurfacePetEnabled)
  const telemetryOptedIn = useAppStore(selectAppRootSurfaceTelemetryOptedIn)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const petVisible = useAppStore((s) => s.petVisible)
  const dictationState = useAppStore((s) => s.dictationState)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const hasSshCredentialRequest = useAppStore((s) => s.sshCredentialQueue.length > 0)

  const shouldMountSetupGuideTelemetryObserver = persistedUIReady
  const shouldMountUpdateCard = shouldMountUpdateCardForStatus(updateStatus)
  const shouldMountDictationController = voiceEnabled || dictationState !== 'idle'
  const renderPetOverlay = shouldRenderPetOverlay({ persistedUIReady, petEnabled, petVisible })

  return (
    <>
      {floatingWorkspace.shouldMountPanel ? (
        <Suspense fallback={null}>
          <OverlayBoundary
            boundaryId="overlay.floating-workspace"
            resetKey={floatingWorkspace.open}
            title={translate('auto.App.1b3024bcd6', 'The floating workspace hit an error.')}
            description={translate(
              'auto.App.7cbfbf622f',
              'Retry the floating workspace or close and reopen it.'
            )}
          >
            <FloatingTerminalPanel
              open={floatingWorkspace.open}
              onOpenChange={floatingWorkspace.setOpenWithFocus}
              tourInteractionSnapshot={floatingWorkspace.tourInteractionSnapshotRef.current}
            />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      {statusBarVisible ? (
        <Suspense
          fallback={
            <div className="h-6 min-h-[24px] shrink-0 border-t border-border bg-[var(--bg-titlebar,var(--card))]" />
          }
        >
          <OverlayBoundary
            boundaryId="overlay.status-bar"
            resetKey={activeView}
            title={translate('auto.App.2e8ff36f94', 'The status bar hit an error.')}
            description={translate(
              'auto.App.8a023cea1f',
              'Retry the status bar to remount its controls.'
            )}
          >
            <StatusBar floatingTerminalOpen={floatingWorkspace.open} />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      {/* Keep Create in the entry bundle so a stale lazy chunk cannot strand users. */}
      {activeModal === 'new-workspace-composer' ? (
        <ModalBoundary boundaryId="modal.new-workspace-composer" resetKey>
          <NewWorkspaceComposerModal />
        </ModalBoundary>
      ) : null}
      <Suspense fallback={null}>
        {shouldMountAddRepoDialog ? (
          <ModalBoundary boundaryId="modal.add-repo" resetKey={activeModal === 'add-repo'}>
            <AddRepoDialog />
          </ModalBoundary>
        ) : null}
        {/* Settings can add projects without Sidebar; host its handoff dialogs here too. */}
        {activeModal === 'confirm-non-git-folder' ? (
          <ModalBoundary boundaryId="modal.confirm-non-git-folder" resetKey>
            <NonGitFolderDialog />
          </ModalBoundary>
        ) : null}
        {activeModal === 'confirm-add-project-from-folder' ? (
          <ModalBoundary boundaryId="modal.confirm-add-project-from-folder" resetKey>
            <AddProjectFromFolderDialog />
          </ModalBoundary>
        ) : null}
        {activeModal === 'project-added' ? (
          <ModalBoundary boundaryId="modal.project-added" resetKey>
            <ProjectAddedDialog />
          </ModalBoundary>
        ) : null}
        {/* Root hosting prevents chat capture handlers receiving history-dialog events. */}
        {activeModal === 'agent-session-history' ? (
          <ModalBoundary boundaryId="modal.agent-session-history" resetKey>
            <AiVaultSessionHistoryDialog />
          </ModalBoundary>
        ) : null}
        {/* Own store, not activeModal: another modal must never evict a running move. */}
        <WslMoveDialogHost />
        {/* Opened by toast, SSH host row and terminal pane. */}
        {activeModal === 'node-dist-mirror' ? (
          <ModalBoundary boundaryId="modal.node-dist-mirror" resetKey>
            <NodeDistMirrorDialog />
          </ModalBoundary>
        ) : null}
        {/* The viewer must outlive the virtualized chat row that opened it. */}
        {activeModal === 'diagram-viewer' ? (
          <ModalBoundary boundaryId="modal.diagram-viewer" resetKey>
            <DiagramViewerModal />
          </ModalBoundary>
        ) : null}
      </Suspense>
      {/* Keep lazy root surfaces under the shared Radix Tooltip provider. */}
      <Suspense fallback={null}>
        {mountedLazyModalIds.has('workspace-cleanup') ? (
          <ModalBoundary
            boundaryId="modal.workspace-cleanup"
            resetKey={activeModal === 'workspace-cleanup'}
          >
            <WorkspaceCleanupDialog />
          </ModalBoundary>
        ) : null}
      </Suspense>
      <Suspense fallback={null}>
        {mountedLazyModalIds.has('quick-open') ? (
          <ModalBoundary boundaryId="modal.quick-open" resetKey={activeModal === 'quick-open'}>
            <QuickOpen />
          </ModalBoundary>
        ) : null}
        {mountedLazyModalIds.has('worktree-palette') ? (
          <ModalBoundary
            boundaryId="modal.worktree-palette"
            resetKey={activeModal === 'worktree-palette'}
          >
            <WorktreeJumpPalette />
          </ModalBoundary>
        ) : null}
        {mountedLazyModalIds.has('setup-guide') ? (
          <ModalBoundary boundaryId="modal.setup-guide" resetKey={activeModal === 'setup-guide'}>
            <SetupGuideModal />
          </ModalBoundary>
        ) : null}
        {mountedLazyModalIds.has('feature-wall') ? (
          <ModalBoundary boundaryId="modal.feature-wall" resetKey={activeModal === 'feature-wall'}>
            <FeatureWallModal />
          </ModalBoundary>
        ) : null}
        {mountedLazyModalIds.has('feature-tips') ? (
          <ModalBoundary boundaryId="modal.feature-tips" resetKey={activeModal === 'feature-tips'}>
            <FeatureTipsModal />
          </ModalBoundary>
        ) : null}
      </Suspense>
      {shouldMountSetupGuideTelemetryObserver ? (
        <Suspense fallback={null}>
          <SetupGuideTelemetryObserver />
        </Suspense>
      ) : null}
      {activeContextualTourId !== null ? (
        <Suspense fallback={null}>
          <ContextualTourOverlay />
        </Suspense>
      ) : null}
      {/* Wait for UI hydration so default visibility cannot flash a saved-hidden pet. */}
      {renderPetOverlay ? (
        <Suspense fallback={null}>
          <OverlayBoundary boundaryId="overlay.pet" resetKey={petVisible}>
            <PetOverlay />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      <NotificationCardStack>
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
      </NotificationCardStack>
      <OverlayBoundary boundaryId="overlay.native-chat-resume-on-restart" resetKey={activeView}>
        <NativeChatResumeOnRestartModal />
      </OverlayBoundary>
      <OverlayBoundary boundaryId="overlay.star-nag-toast" resetKey={activeView}>
        <StarNagToastHost />
      </OverlayBoundary>
      <StarNagAgentValueMomentObserver />
      {/* Mount once per session; the internal gate selects pre-telemetry users (telemetry-plan.md §First-launch experience). */}
      <OverlayBoundary boundaryId="overlay.telemetry-first-launch" resetKey={telemetryOptedIn}>
        <TelemetryFirstLaunchSurface />
      </OverlayBoundary>
      <OverlayBoundary boundaryId="overlay.zoom" resetKey={activeView}>
        <ZoomOverlay />
      </OverlayBoundary>
      <Suspense fallback={null}>
        {activeModal === 'delete-worktree' ? (
          <ModalBoundary boundaryId="modal.delete-worktree" resetKey>
            <DeleteWorktreeDialog />
          </ModalBoundary>
        ) : null}
        {activeModal === 'preserved-branch-review' ? (
          <ModalBoundary boundaryId="modal.preserved-branch-review" resetKey>
            <PreservedBranchBatchReviewModal />
          </ModalBoundary>
        ) : null}
      </Suspense>
      {hasSshCredentialRequest ? (
        <Suspense fallback={null}>
          <ModalBoundary boundaryId="modal.ssh-passphrase" resetKey={activeModal}>
            <SshPassphraseDialog />
          </ModalBoundary>
        </Suspense>
      ) : null}
      <ModalBoundary boundaryId="modal.markdown-template-picker" resetKey={activeModal}>
        <MarkdownTemplatePicker />
      </ModalBoundary>
      <RecoverableRenderErrorBoundary
        boundaryId="modal.crash-report"
        surface="modal"
        reportAsCrash={false}
        resetKey={activeModal}
        compact
        title={translate('auto.App.722d03aa62', 'The crash report dialog hit an error.')}
        description={translate(
          'auto.App.acd66311dc',
          'Use the Help menu after retrying if you still need diagnostics.'
        )}
      >
        <CrashReportDialog />
      </RecoverableRenderErrorBoundary>
      {onboardingGate.onboarding && onboardingGate.shouldRender
        ? createPortal(
            <Suspense fallback={null}>
              <RecoverableRenderErrorBoundary
                boundaryId="modal.onboarding"
                surface="modal"
                className="fixed inset-0 z-40 bg-background"
                title={translate('auto.App.f02d37278a', 'Onboarding hit an error.')}
                description={translate(
                  'auto.App.221a95ba38',
                  'Retry onboarding or close it and continue in the app.'
                )}
              >
                {languageReady ? (
                  <OnboardingFlow
                    onboarding={onboardingGate.onboarding}
                    onOnboardingChange={onboardingGate.setOnboarding}
                  />
                ) : (
                  <OnboardingLanguageLoading />
                )}
              </RecoverableRenderErrorBoundary>
            </Suspense>,
            document.body
          )
        : null}
      {shouldMountDictationController ? (
        <Suspense fallback={null}>
          <OverlayBoundary boundaryId="overlay.dictation" resetKey={activeView}>
            <DictationController />
          </OverlayBoundary>
        </Suspense>
      ) : null}
      <OverlayBoundary boundaryId="overlay.recent-tab-switcher" resetKey={activeView}>
        <RecentTabSwitcher />
      </OverlayBoundary>
      {/* Its live terminal requires the link-routing preference context. */}
      <OverlayBoundary boundaryId="overlay.skill-freshness-update-dialog">
        <SkillFreshnessUpdateDialog />
      </OverlayBoundary>
      <Suspense fallback={null}>
        <OverlayBoundary boundaryId="overlay.remote-server-update-dialog">
          <RemoteServerUpdateDialog />
        </OverlayBoundary>
      </Suspense>
    </>
  )
}
