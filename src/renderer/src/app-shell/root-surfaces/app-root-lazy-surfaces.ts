import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'

export const NewWorkspaceComposerModal = lazy(
  () => import('../../components/new-workspace/composer/NewWorkspaceComposerModal')
)
export const SkillFreshnessUpdateDialog = lazy(() =>
  import('../../components/skills/freshness/SkillFreshnessUpdateDialog').then((module) => ({
    default: module.SkillFreshnessUpdateDialog
  }))
)
export const QuickOpen = lazy(() => import('../../components/file-actions/quick-open/QuickOpen'))
export const WorkspaceCleanupDialog = lazy(
  () => import('../../components/workspace-cleanup/WorkspaceCleanupDialog')
)
export const StatusBar = lazy(() =>
  import('../../components/status-bar/StatusBar').then((module) => ({ default: module.StatusBar }))
)
export const SetupGuideModal = lazy(() => import('../../components/setup-guide/SetupGuideModal'))
export const FeatureWallModal = lazy(() => import('../../components/feature-wall/FeatureWallModal'))
export const FeatureTipsModal = lazy(() => import('../../components/feature-tips/FeatureTipsModal'))
export const AddRepoDialog = lazy(
  () => import('../../components/sidebar/project-admission/dialog/AddRepoDialog')
)
export const NonGitFolderDialog = lazy(
  () => import('../../components/sidebar/project-admission/dialog/NonGitFolderDialog')
)
export const AddProjectFromFolderDialog = lazy(
  () => import('../../components/sidebar/project-admission/dialog/AddProjectFromFolderDialog')
)
export const DiagramViewerModal = lazy(
  () => import('../../components/editor/diagrams/DiagramViewerModal')
)
export const ProjectAddedDialog = lazy(
  () => import('../../components/sidebar/project-admission/completion/ProjectAddedDialog')
)
export const NodeDistMirrorDialog = lazy(
  () => import('../../components/ssh-host-recovery/NodeDistMirrorDialog')
)
export const AiVaultSessionHistoryDialog = lazy(
  () => import('../../components/right-sidebar/ai-vault/session-list/AiVaultSessionHistoryDialog')
)
export const NativeChatAccountUsageDialog = lazy(
  () => import('../../components/native-chat/usage/NativeChatAccountUsageDialog')
)
export const DeleteWorktreeDialog = lazy(
  () => import('../../components/sidebar/workspace-actions/deletion/DeleteWorktreeDialog')
)
export const PreservedBranchBatchReviewModal = lazy(
  () =>
    import('../../components/sidebar/workspace-actions/deletion/PreservedBranchBatchReviewModal')
)
export const DictationController = lazy(() =>
  import('../../components/dictation/DictationController').then((module) => ({
    default: module.DictationController
  }))
)
export const SshPassphraseDialog = lazy(() =>
  import('../../components/ssh-authentication/SshPassphraseDialog').then((module) => ({
    default: module.SshPassphraseDialog
  }))
)
export const RemoteServerUpdateDialog = lazy(
  () => import('../../components/settings/runtime-environments/updates/RemoteServerUpdateDialog')
)
export const ContextualTourOverlay = lazy(() =>
  import('../../components/contextual-tours/ContextualTourOverlay').then((module) => ({
    default: module.ContextualTourOverlay
  }))
)
export const SetupGuideTelemetryObserver = lazy(() =>
  import('../../components/setup-guide/SetupGuideTelemetryObserver').then((module) => ({
    default: module.SetupGuideTelemetryObserver
  }))
)
export const FloatingTerminalPanel = lazy(() =>
  import('../../components/floating-terminal/FloatingTerminalPanel').then((module) => ({
    default: module.FloatingTerminalPanel
  }))
)
// Load the pet asset/overlay only when enabled.
export const PetOverlay = lazy(() => import('../../components/pet/PetOverlay'))
// Avoid fetching onboarding assets for users past first launch.
export const OnboardingFlow = lazy(() => import('../../components/onboarding/OnboardingFlow'))
