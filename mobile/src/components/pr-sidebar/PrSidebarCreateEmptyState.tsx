import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitPullRequestArrow, Link2, Link2Off } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { resolveMobilePrPrefill, type MobilePrPrefill } from '../../source-control/mobile-pr-create'
import { fetchWorktreeLinkedPR, unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { openMobilePrUrl } from '../MobilePrComposeSheet'
import { MobilePrComposeForm } from './MobilePrComposeForm'
import { MobileLinkPrForm } from './MobileLinkPrForm'
import { prActionsStyles as actionStyles } from './pr-actions-styles'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  // Refetches the sidebar so it transitions from 'none' to the ready PR view.
  onCreated: () => void
}

type Mode = 'choose' | 'create' | 'link'

// Empty state for a branch with no PR: offers both Create and Link (desktop parity).
// Create resolves the hosted-review prefill (provider/base/title/body — provider-
// agnostic) and renders the compose form inline; Link renders a number/URL form
// inline. Both forms render inline (not as a nested BottomDrawer, which a
// ScrollView would clip) and refetch the sidebar on success.
export function PrSidebarCreateEmptyState({ client, worktreeId, gitBranch, onCreated }: Props) {
  const [prefill, setPrefill] = useState<MobilePrPrefill | null>(null)
  const [mode, setMode] = useState<Mode>('choose')
  const [loading, setLoading] = useState(false)
  // A persisted linkedPR while the branch shows no PR means the linked PR couldn't be
  // resolved (deleted/transferred/cross-repo). Surface Unlink so the user can recover
  // instead of being trapped re-linking a dead PR.
  const [orphanLinkedPR, setOrphanLinkedPR] = useState<number | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!client) {
      setOrphanLinkedPR(null)
      return
    }
    void fetchWorktreeLinkedPR(client, worktreeId).then((n) => {
      if (!cancelled) {
        setOrphanLinkedPR(n)
      }
    })
    return () => {
      cancelled = true
    }
  }, [client, worktreeId])

  const unlink = async (): Promise<void> => {
    if (!client || unlinking) {
      return
    }
    setUnlinking(true)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId)
      if (outcome.ok) {
        setOrphanLinkedPR(null)
        onCreated()
      }
    } finally {
      setUnlinking(false)
    }
  }

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
      setMode('create')
    } finally {
      setLoading(false)
    }
  }

  const canCreate = !!client && !!gitBranch

  if (mode === 'create' && prefill) {
    return (
      <View style={styles.stateArea}>
        <MobilePrComposeForm
          client={client}
          worktreeId={worktreeId}
          prefill={prefill}
          head={gitBranch}
          onCancel={() => setMode('choose')}
          onCreated={(url) => {
            setMode('choose')
            openMobilePrUrl(url)
            onCreated()
          }}
        />
      </View>
    )
  }

  if (mode === 'link') {
    return (
      <View style={styles.stateArea}>
        <MobileLinkPrForm
          client={client}
          worktreeId={worktreeId}
          onCancel={() => setMode('choose')}
          onLinked={() => {
            setMode('choose')
            onCreated()
          }}
        />
      </View>
    )
  }

  return (
    <View style={styles.stateArea}>
      <Text style={styles.stateText}>
        {orphanLinkedPR
          ? `Linked pull request #${orphanLinkedPR} is unavailable. Create a new one, link another, or unlink.`
          : 'No open pull request for this branch.'}
      </Text>
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
          <GitPullRequestArrow size={16} color={colors.bgBase} strokeWidth={2.2} />
        )}
        <Text style={[actionStyles.actionButtonText, actionStyles.actionButtonTextPrimary]}>
          Create pull request
        </Text>
      </Pressable>
      <Pressable
        style={[actionStyles.actionButton, !client && actionStyles.actionButtonDisabled]}
        onPress={() => setMode('link')}
        disabled={!client}
        accessibilityRole="button"
        accessibilityLabel="Link existing pull request"
      >
        <Link2 size={16} color={colors.textPrimary} strokeWidth={2.2} />
        <Text style={actionStyles.actionButtonText} numberOfLines={1}>
          Link existing pull request
        </Text>
      </Pressable>
      {orphanLinkedPR ? (
        <Pressable
          style={[
            actionStyles.actionButton,
            (!client || unlinking) && actionStyles.actionButtonDisabled
          ]}
          onPress={() => void unlink()}
          disabled={!client || unlinking}
          accessibilityRole="button"
          accessibilityLabel="Unlink pull request"
        >
          {unlinking ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <Link2Off size={16} color={colors.textSecondary} strokeWidth={2.2} />
          )}
          <Text style={actionStyles.actionButtonText}>Unlink</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
