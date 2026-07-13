import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { RotateCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useMobilePrActions, type MobilePrActions } from '../session/use-mobile-pr-actions'
import {
  useMobilePrCommentActions,
  type MobilePrCommentActions
} from '../session/use-mobile-pr-comment-actions'
import {
  useMobilePrTitleAction,
  type MobilePrTitleAction
} from '../session/use-mobile-pr-title-action'
import { useMobilePrAiTriage, type MobilePrAiTriage } from '../session/use-mobile-pr-ai-triage'
import { usePRBotAuthorOverrides } from '../session/use-pr-bot-author-overrides'
import { buildFixChecksPrompt, buildResolveConflictsPrompt } from '../session/pr-ai-triage-prompt'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import { PRSidebarHeader } from './pr-sidebar/PRSidebarHeader'
import { PRConflictingFilesSection } from './pr-sidebar/PRConflictingFilesSection'
import { PRActionsSection } from './pr-sidebar/PRActionsSection'
import { PRReviewersSection } from './pr-sidebar/PRReviewersSection'
import { PRChecksSection } from './pr-sidebar/PRChecksSection'
import { PRCommentsSection } from './pr-sidebar/PRCommentsSection'
import { PrSidebarCreateEmptyState } from './pr-sidebar/PrSidebarCreateEmptyState'

type Props = {
  state: PrSidebarState
  onRetry: () => void
  // Re-fetches authoritative PR data after a successful mutation (U3/U6) or create.
  refetch: () => void
  // Threaded to sections for github.* fetches + mutations.
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  headSha: string | null
  bottomInset?: number
  // Hub chrome already shows open-on-web; hide the in-body icon there.
  showOpenOnWeb?: boolean
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
  showOpenOnWeb = true
}: Props) {
  const branch = prSidebarRenderBranch(state)
  // prNumber is 0 until ready; the hook gates on `ready` so it never fires early.
  const prNumber = state.kind === 'ready' ? state.data.pr.number : 0
  // Prefer the stable PRInfo.prRepo reference — cloning owner/repo each render
  // reallocates and thrash-updates the mutation/comment/title hooks.
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
  const triage = useMobilePrAiTriage({ client, connState, worktreeId })
  // Keyed on the PR payload identity so overrides re-fetch with each PR refetch
  // instead of staying a stale one-shot snapshot for the whole session.
  const botAuthorOverrides = usePRBotAuthorOverrides(
    client,
    connState,
    state.kind === 'ready' ? state.data.details : null
  )

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      // Why: root-comment / reply composers sit at the bottom of this scroll
      // area; without keyboard insets the focused field stays under the keyboard.
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
        commentActions={commentActions}
        titleAction={titleAction}
        triage={triage}
        botAuthorOverrides={botAuthorOverrides}
        showOpenOnWeb={showOpenOnWeb}
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
  commentActions,
  titleAction,
  triage,
  showOpenOnWeb,
  botAuthorOverrides
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
  refetch: () => void
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  actions: MobilePrActions
  commentActions: MobilePrCommentActions
  titleAction: MobilePrTitleAction
  triage: MobilePrAiTriage
  showOpenOnWeb: boolean
  botAuthorOverrides: ReadonlySet<string>
}) {
  if (branch === 'loading') {
    return (
      <View style={styles.stateArea}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>Loading pull request…</Text>
      </View>
    )
  }
  if (branch === 'error') {
    const message = state.kind === 'error' ? state.message : 'Something went wrong.'
    return (
      <View style={styles.stateArea}>
        <Text style={styles.stateText}>{message}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading pull request"
        >
          <RotateCw size={14} color={colors.textPrimary} strokeWidth={2.2} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }
  if (branch === 'blocked' || actions.blocked) {
    // Permanent failure (R9): explanatory, no retry-encouragement styling. A
    // mutation-time block (actions.blocked) routes here even from a ready state.
    const message =
      actions.blocked ??
      (state.kind === 'blocked'
        ? state.message
        : 'Not permitted — your GitHub account is not connected.')
    return (
      <View style={styles.stateArea}>
        <Text style={styles.blockedText}>{message}</Text>
      </View>
    )
  }
  if (branch === 'none') {
    // GitHub repo, but the current branch has no open PR — offer to create one
    // (desktop parity) rather than showing a dead-end message.
    return (
      <PrSidebarCreateEmptyState
        client={client}
        worktreeId={worktreeId}
        gitBranch={gitBranch}
        gitStatus={gitStatus}
        connState={connState}
        onCreated={refetch}
      />
    )
  }
  if (branch === 'ready' && state.kind === 'ready') {
    return (
      <PrSidebarSections
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
      />
    )
  }
  return null
}

function PrSidebarSections({
  data,
  client,
  worktreeId,
  actions,
  commentActions,
  titleAction,
  triage,
  refetch,
  showOpenOnWeb,
  botAuthorOverrides
}: {
  data: Extract<PrSidebarState, { kind: 'ready' }>['data']
  client: RpcClient | null
  worktreeId: string
  actions: MobilePrActions
  commentActions: MobilePrCommentActions
  titleAction: MobilePrTitleAction
  triage: MobilePrAiTriage
  refetch: () => void
  showOpenOnWeb: boolean
  botAuthorOverrides: ReadonlySet<string>
}) {
  const pr = data.pr
  // Bind the triage launchers to this PR's data; the prompt builders are pure so
  // building lazily inside launch() keeps a stale capture from leaking in.
  const checksTriage = {
    fixChecks: () =>
      void triage.launch('fix-checks', () =>
        buildFixChecksPrompt({
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.url,
          checks: data.checks
        })
      ),
    isBusy: triage.isBusy('fix-checks'),
    error: triage.error
  }
  const conflictsTriage = {
    resolveConflicts: () =>
      void triage.launch('resolve-conflicts', () =>
        buildResolveConflictsPrompt({
          prNumber: pr.number,
          baseRef: pr.conflictSummary?.baseRef ?? pr.baseRefName ?? null,
          files: pr.conflictSummary?.files ?? []
        })
      ),
    isBusy: triage.isBusy('resolve-conflicts'),
    error: triage.error
  }
  // One card for identity + actions so the ready PR isn't a stack of thin
  // duplicate blocks (badge row, title, branches, then another action band).
  return (
    <>
      <View style={styles.section}>
        <View style={styles.sectionBody}>
          <PRSidebarHeader
            pr={data.pr}
            details={data.details}
            titleAction={titleAction}
            showOpenOnWeb={showOpenOnWeb}
            bare
          />
          <PRActionsSection
            pr={data.pr}
            actions={actions}
            client={client}
            worktreeId={worktreeId}
            onUnlinked={refetch}
          />
        </View>
      </View>
      {/* Own titled section when present; null otherwise (no empty chrome). */}
      <PRConflictingFilesSection pr={data.pr} triage={conflictsTriage} />
      <PRReviewersSection
        details={data.details}
        actions={actions}
        client={client}
        worktreeId={worktreeId}
      />
      <PRChecksSection
        checks={data.checks}
        client={client}
        worktreeId={worktreeId}
        prRepo={data.pr.prRepo ?? null}
        actions={actions}
        triage={checksTriage}
      />
      <PRCommentsSection
        details={data.details}
        prState={data.pr.state}
        prRepo={data.pr.prRepo ?? null}
        actions={commentActions}
        botAuthorOverrides={botAuthorOverrides}
      />
    </>
  )
}
