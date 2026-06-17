import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitPullRequest, Link2 } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { resolveMobilePrPrefill, type MobilePrPrefill } from '../../source-control/mobile-pr-create'
import { MobilePrComposeSheet, openMobilePrUrl } from '../MobilePrComposeSheet'
import { MobileLinkPrSheet } from './MobileLinkPrSheet'
import { prActionsStyles as actionStyles } from './pr-actions-styles'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  // Refetches the sidebar so it transitions from 'none' to the ready PR view.
  onCreated: () => void
}

// Empty state for a branch with no PR: offers both Create and Link (desktop parity).
// Create resolves the hosted-review prefill (provider/base/title/body — provider-
// agnostic) and opens the compose sheet; Link opens a number/URL sheet that persists
// linkedPR via worktree.set. Both refetch the sidebar on success.
export function PrSidebarCreateEmptyState({ client, worktreeId, gitBranch, onCreated }: Props) {
  const [prefill, setPrefill] = useState<MobilePrPrefill | null>(null)
  const [composeVisible, setComposeVisible] = useState(false)
  const [linkVisible, setLinkVisible] = useState(false)
  const [loading, setLoading] = useState(false)

  const openComposer = async (): Promise<void> => {
    if (!client || loading) {
      return
    }
    setLoading(true)
    try {
      // Git-status fields are best-effort here (the sidebar has no working-tree
      // state); base/title/body come from host eligibility regardless, and create
      // does the authoritative branch-state validation.
      const resolved = await resolveMobilePrPrefill(client, worktreeId, {
        branch: gitBranch ?? undefined,
        title: gitBranch ?? '',
        hasUncommittedChanges: false,
        hasUpstream: true,
        ahead: 1,
        behind: 0
      })
      setPrefill(resolved)
      setComposeVisible(true)
    } finally {
      setLoading(false)
    }
  }

  const canCreate = !!client && !!gitBranch

  return (
    <View style={styles.stateArea}>
      <Text style={styles.stateText}>No open pull request for this branch.</Text>
      <Pressable
        style={[
          actionStyles.actionButton,
          actionStyles.actionButtonPrimary,
          (!canCreate || loading) && actionStyles.actionButtonDisabled
        ]}
        onPress={() => void openComposer()}
        disabled={!canCreate || loading}
        accessibilityRole="button"
        accessibilityLabel="Create pull request"
      >
        {loading ? (
          <ActivityIndicator color={colors.bgBase} />
        ) : (
          <GitPullRequest size={16} color={colors.bgBase} strokeWidth={2.2} />
        )}
        <Text style={[actionStyles.actionButtonText, actionStyles.actionButtonTextPrimary]}>
          Create pull request
        </Text>
      </Pressable>
      <Pressable
        style={[actionStyles.actionButton, !client && actionStyles.actionButtonDisabled]}
        onPress={() => setLinkVisible(true)}
        disabled={!client}
        accessibilityRole="button"
        accessibilityLabel="Link existing pull request"
      >
        <Link2 size={16} color={colors.textPrimary} strokeWidth={2.2} />
        <Text style={actionStyles.actionButtonText}>Link existing pull request</Text>
      </Pressable>

      {prefill ? (
        <MobilePrComposeSheet
          visible={composeVisible}
          client={client}
          worktreeId={worktreeId}
          prefill={prefill}
          head={gitBranch}
          onClose={() => setComposeVisible(false)}
          onCreated={(url) => {
            setComposeVisible(false)
            openMobilePrUrl(url)
            onCreated()
          }}
        />
      ) : null}
      <MobileLinkPrSheet
        visible={linkVisible}
        client={client}
        worktreeId={worktreeId}
        onClose={() => setLinkVisible(false)}
        onLinked={() => {
          setLinkVisible(false)
          onCreated()
        }}
      />
    </View>
  )
}
