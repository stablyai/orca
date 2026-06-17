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
import { buildFixChecksPrompt, buildResolveConflictsPrompt } from '../session/pr-ai-triage-prompt'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'
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
  // Current git branch — feeds the create-PR prefill in the no-PR empty state.
  gitBranch: string | null
  headSha: string | null
  // Applied by the docked column so content clears the home indicator (the screen's
  // SafeAreaView is edges={['top']} only).
  bottomInset?: number
}

// The shell switches on the controller's state machine and renders the sections
// (header/actions/reviewers/checks). The mutation hook is created here (hooks must
// run unconditionally) and only fires once a PR is ready. Style only from mobile-theme.
export function MobilePRSidebar({
  state,
  onRetry,
  refetch,
  client,
  connState,
  worktreeId,
  gitBranch,
  headSha,
  bottomInset = 0
}: Props) {
  const branch = prSidebarRenderBranch(state)
  // prNumber is 0 until ready; the hook gates on `ready` so it never fires early.
  const prNumber = state.kind === 'ready' ? state.data.pr.number : 0
  const prRepo =
    state.kind === 'ready'
      ? state.data.pr.prRepo
        ? { owner: state.data.pr.prRepo.owner, repo: state.data.pr.prRepo.repo }
        : null
      : null
  const actions = useMobilePrActions({
    client,
    connState,
    worktreeId,
    prNumber,
    headSha,
    prRepo,
    refetch
  })
  // Separate hook for the interactive comment timeline (reply/resolve/add). Like
  // useMobilePrActions it must run unconditionally; it gates internally on a client.
  const commentActions = useMobilePrCommentActions({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch
  })
  // Inline title-edit action. Like the others it must run unconditionally and gates
  // internally on a client; refetches authoritative PR data after a successful edit.
  const titleAction = useMobilePrTitleAction({
    client,
    connState,
    worktreeId,
    prNumber,
    prRepo,
    refetch
  })
  // AI triage (Fix checks / Resolve conflicts). Like the other hooks it must run
  // unconditionally; it gates internally on a connected client.
  const triage = useMobilePrAiTriage({ client, connState, worktreeId })

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <PrSidebarContent
        branch={branch}
        state={state}
        onRetry={onRetry}
        refetch={refetch}
        client={client}
        worktreeId={worktreeId}
        gitBranch={gitBranch}
        actions={actions}
        commentActions={commentActions}
        titleAction={titleAction}
        triage={triage}
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
  worktreeId,
  gitBranch,
  actions,
  commentActions,
  titleAction,
  triage
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
  refetch: () => void
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  actions: MobilePrActions
  commentActions: MobilePrCommentActions
  titleAction: MobilePrTitleAction
  triage: MobilePrAiTriage
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
  refetch
}: {
  data: Extract<PrSidebarState, { kind: 'ready' }>['data']
  client: RpcClient | null
  worktreeId: string
  actions: MobilePrActions
  commentActions: MobilePrCommentActions
  titleAction: MobilePrTitleAction
  triage: MobilePrAiTriage
  refetch: () => void
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
  return (
    <>
      <PRSidebarHeader pr={data.pr} details={data.details} titleAction={titleAction} />
      {/* Conflicting-files section mirrors desktop order: directly below the header,
          before actions/checks. Renders only when the PR has merge conflicts. */}
      <PRConflictingFilesSection pr={data.pr} triage={conflictsTriage} />
      <PRActionsSection
        pr={data.pr}
        actions={actions}
        client={client}
        worktreeId={worktreeId}
        onUnlinked={refetch}
      />
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
      />
    </>
  )
}
