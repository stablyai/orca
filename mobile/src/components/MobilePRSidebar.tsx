import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { RotateCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useMobilePrActions, type MobilePrActions } from '../session/use-mobile-pr-actions'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'
import { PRSidebarHeader } from './pr-sidebar/PRSidebarHeader'
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

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
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
  actions
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
  refetch: () => void
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  actions: MobilePrActions
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
      />
    )
  }
  return null
}

function PrSidebarSections({
  data,
  client,
  worktreeId,
  actions
}: {
  data: Extract<PrSidebarState, { kind: 'ready' }>['data']
  client: RpcClient | null
  worktreeId: string
  actions: MobilePrActions
}) {
  return (
    <>
      <PRSidebarHeader pr={data.pr} details={data.details} />
      <PRActionsSection pr={data.pr} actions={actions} />
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
      />
      <PRCommentsSection details={data.details} />
    </>
  )
}
