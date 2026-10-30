import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { RotateCw } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { PrSidebarLoadOptions } from '../session/use-mobile-pr-sidebar-controller'
import type { ConnectionState } from '../transport/types'
import type { MobilePrFileViewed } from '../session/use-mobile-pr-file-viewed'
import type { RpcClient } from '../transport/rpc-client'
import { useMobilePrActions, type MobilePrActions } from '../session/use-mobile-pr-actions'
import { useMobilePrCommentActions } from '../session/use-mobile-pr-comment-actions'
import { useMobilePrTitleAction } from '../session/use-mobile-pr-title-action'
import { useMobilePrAiTriage } from '../session/use-mobile-pr-ai-triage'
import { useHostProtocolGates } from './host-protocol-gates-context'
import { usePRBotAuthorOverrides } from '../session/use-pr-bot-author-overrides'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import { PrSidebarCreateEmptyState } from './pr-sidebar/PrSidebarCreateEmptyState'
import { PRViewSections } from './pr-sidebar/PRViewSections'

type Props = {
  state: PrSidebarState
  onRetry: () => void
  // Re-fetches authoritative PR data after a successful mutation (U3/U6) or create.
  refetch: (options?: PrSidebarLoadOptions) => void
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  headSha: string | null
  bottomInset?: number
  // Hub chrome already shows open-on-web; hide the in-body icon there.
  showOpenOnWeb?: boolean
  /** Named when an AI button's agent starts; the branch stands in when absent. */
  workspaceLabel: string | null
  /** Opens a changed file's diff from the Files tab. */
  onOpenPrFile?: (path: string) => void
  /** The controller's viewed writer, so pending writes outlive this view. */
  prFileViewed: MobilePrFileViewed
}

// Mutation hooks run unconditionally here and gate internally until a PR is ready.
export function MobilePRSidebar({
  state,
  onRetry,
  refetch,
  client,
  connState,
  worktreeId,
  gitBranch,
  gitStatus,
  headSha,
  bottomInset = 0,
  showOpenOnWeb = true,
  workspaceLabel,
  onOpenPrFile,
  prFileViewed
}: Props) {
  useMobileColorScheme()
  const launchWorkspaceLabel = workspaceLabel || gitBranch
  const branch = prSidebarRenderBranch(state)
  const prNumber = state.kind === 'ready' ? state.data.pr.number : 0
  // Keep stable PRInfo.prRepo identity; cloning owner/repo thrashes mutation/comment/title hooks.
  const prRepo = state.kind === 'ready' ? (state.data.pr.prRepo ?? null) : null
  const actions = useMobilePrActions({
    client,
    connState,
    worktreeId,
    prNumber,
    headSha,
    prRepo,
    refetch
  })
  const commentActions = useMobilePrCommentActions({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch
  })
  const titleAction = useMobilePrTitleAction({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch
  })
  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const triage = useMobilePrAiTriage({
    client,
    connState,
    worktreeId,
    workspaceLabel: launchWorkspaceLabel,
    hostCapabilities,
    hostStatusPending: statusPending,
    hostStatusReadable: statusReadable
  })
  // Key on comments: local viewed-state patches replace details but change no authors.
  const botAuthorOverrides = usePRBotAuthorOverrides(
    client,
    connState,
    state.kind === 'ready' ? (state.data.details?.comments ?? null) : null
  )

  if (branch === 'ready' && state.kind === 'ready' && !actions.blocked) {
    return (
      <PRViewSections
        data={state.data}
        client={client}
        worktreeId={worktreeId}
        actions={actions}
        commentActions={commentActions}
        titleAction={titleAction}
        triage={triage}
        refetch={refetch}
        botAuthorOverrides={botAuthorOverrides}
        showOpenOnWeb={showOpenOnWeb}
        bottomInset={bottomInset}
        onOpenPrFile={onOpenPrFile}
        prFileViewed={prFileViewed}
      />
    )
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      // Inset scroll for keyboard or bottom root/reply composers remain covered.
      automaticallyAdjustKeyboardInsets
      showsVerticalScrollIndicator={false}
    >
      <PrSidebarContent
        branch={branch}
        state={state}
        onRetry={onRetry}
        refetch={refetch}
        client={client}
        connState={connState}
        worktreeId={worktreeId}
        gitBranch={gitBranch}
        gitStatus={gitStatus}
        actions={actions}
        workspaceLabel={launchWorkspaceLabel}
      />
    </ScrollView>
  )
}

function PrSidebarContent({
  branch,
  state,
  onRetry,
  refetch,
  client,
  connState,
  worktreeId,
  gitBranch,
  gitStatus,
  actions,
  workspaceLabel
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
  refetch: (options?: PrSidebarLoadOptions) => void
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  actions: MobilePrActions
  workspaceLabel: string | null
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  if (branch === 'loading') {
    return (
      <View style={styles.stateArea}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>
          {t('components.prSidebar.loading', 'Loading pull request…')}
        </Text>
      </View>
    )
  }
  if (branch === 'error') {
    const message =
      state.kind === 'error'
        ? state.message
        : t('components.prSidebar.loadFailed', 'Something went wrong.')
    return (
      <View style={styles.stateArea}>
        <Text style={styles.stateText}>{message}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t('components.prSidebar.retryLoading', 'Retry loading pull request')}
        >
          <RotateCw size={14} color={colors.textPrimary} strokeWidth={2.2} />
          <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      </View>
    )
  }
  if (branch === 'blocked' || actions.blocked) {
    // Permanent R9 block has no retry styling; mutation-time blocked actions reach this state too.
    const message =
      actions.blocked ??
      (state.kind === 'blocked'
        ? state.message
        : t(
            'components.prSidebar.notPermitted',
            'Not permitted — your GitHub account is not connected.'
          ))
    return (
      <View style={styles.stateArea}>
        <Text style={styles.blockedText}>{message}</Text>
      </View>
    )
  }
  if (branch === 'none') {
    // Offer create for GitHub branch without PR, matching desktop rather than dead-end message.
    return (
      <PrSidebarCreateEmptyState
        client={client}
        worktreeId={worktreeId}
        gitBranch={gitBranch}
        gitStatus={gitStatus}
        connState={connState}
        workspaceLabel={workspaceLabel}
        onCreated={refetch}
      />
    )
  }
  return null
}
