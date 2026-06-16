import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { RotateCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { RpcClient } from '../transport/rpc-client'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'
import { PRSidebarHeader } from './pr-sidebar/PRSidebarHeader'
import { PRReviewersSection } from './pr-sidebar/PRReviewersSection'
import { PRChecksSection } from './pr-sidebar/PRChecksSection'

type Props = {
  state: PrSidebarState
  onRetry: () => void
  // Threaded to PRChecksSection for lazy github.prCheckDetails fetches.
  client: RpcClient | null
  worktreeId: string
  // Applied by the docked column so content clears the home indicator (the screen's
  // SafeAreaView is edges={['top']} only).
  bottomInset?: number
}

// The shell switches on the controller's state machine and renders the read-only
// sections (header/reviewers/checks). Style only from mobile-theme.
export function MobilePRSidebar({ state, onRetry, client, worktreeId, bottomInset = 0 }: Props) {
  const branch = prSidebarRenderBranch(state)
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
        client={client}
        worktreeId={worktreeId}
      />
    </ScrollView>
  )
}

function PrSidebarContent({
  branch,
  state,
  onRetry,
  client,
  worktreeId
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
  client: RpcClient | null
  worktreeId: string
}) {
  if (branch === 'loading') {
    return (
      <View style={styles.stateArea}>
        <ActivityIndicator color={colors.accentBlue} />
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
  if (branch === 'blocked') {
    // Permanent failure (R9): explanatory, no retry-encouragement styling.
    const message =
      state.kind === 'blocked'
        ? state.message
        : 'Not permitted — your GitHub account is not connected.'
    return (
      <View style={styles.stateArea}>
        <Text style={styles.blockedText}>{message}</Text>
      </View>
    )
  }
  if (branch === 'ready' && state.kind === 'ready') {
    return <PrSidebarSections data={state.data} client={client} worktreeId={worktreeId} />
  }
  return null
}

function PrSidebarSections({
  data,
  client,
  worktreeId
}: {
  data: Extract<PrSidebarState, { kind: 'ready' }>['data']
  client: RpcClient | null
  worktreeId: string
}) {
  return (
    <>
      <PRSidebarHeader pr={data.pr} details={data.details} />
      <PRReviewersSection details={data.details} />
      <PRChecksSection
        checks={data.checks}
        client={client}
        worktreeId={worktreeId}
        prRepo={data.pr.prRepo ?? null}
      />
    </>
  )
}
