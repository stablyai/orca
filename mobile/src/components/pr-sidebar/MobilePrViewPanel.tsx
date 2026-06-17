import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, X } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import type { ConnectionState } from '../../transport/types'
import type { RpcClient } from '../../transport/rpc-client'
import { useMobilePrSidebarController } from '../../session/use-mobile-pr-sidebar-controller'
import { MobilePRSidebar } from '../MobilePRSidebar'

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  branch: string | null
  headSha: string | null
  isGithubRepo?: boolean
  branchContextLoaded?: boolean
  // Embedded (docked) drops the full-screen SafeAreaView chrome and shows a close
  // affordance; the dock column owns the safe-area insets. Full-screen otherwise.
  embedded?: boolean
  onRequestClose?: () => void
}

export function MobilePrViewPanel({
  client,
  connState,
  worktreeId,
  branch,
  headSha,
  isGithubRepo = true,
  branchContextLoaded = true,
  embedded = false,
  onRequestClose
}: Props) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const controller = useMobilePrSidebarController({
    client,
    connState,
    worktreeId,
    branch,
    headSha
  })

  // A docked/full-screen PR panel is always visible — there is no drawer to open,
  // so trigger the load directly once context is ready rather than gating on the
  // showPRSidebar overlay flag (KTD4).
  const prSidebarKind = controller.prSidebarState.kind
  const refetch = controller.refetchPRSidebar
  useEffect(() => {
    if (branch && isGithubRepo && prSidebarKind === 'hidden') {
      refetch()
    }
  }, [branch, isGithubRepo, prSidebarKind, refetch])

  // Embedded: the dock column applies the bottom inset; full-screen relies on its own
  // SafeAreaView (edges top only), so content must clear the home indicator itself.
  const sidebarState = !branchContextLoaded
    ? ({ kind: 'loading' } as const)
    : !isGithubRepo
      ? ({
          kind: 'blocked',
          message: 'Hosted review panel unavailable for this provider.'
        } as const)
      : branch === null
        ? ({
            kind: 'error',
            message: 'Current branch unavailable.'
          } as const)
        : controller.prSidebarState
  const sidebar = (
    <MobilePRSidebar
      state={sidebarState}
      onRetry={controller.retryPRSidebar}
      refetch={controller.refetchPRSidebar}
      client={client}
      connState={connState}
      worktreeId={worktreeId}
      gitBranch={branch}
      headSha={headSha}
      bottomInset={insets.bottom}
    />
  )

  if (embedded) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.topBar}>
            <Pressable
              style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
              onPress={onRequestClose}
              hitSlop={8}
              accessibilityLabel="Close pull request panel"
            >
              <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1}>
              Pull Request
            </Text>
          </View>
        </View>
        {sidebar}
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to session"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            Pull Request
          </Text>
        </View>
      </View>
      {sidebar}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  }
})
