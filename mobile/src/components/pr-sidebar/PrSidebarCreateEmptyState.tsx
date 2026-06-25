import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitPullRequestArrow, Link2, RefreshCw } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import { resolveMobilePrPrefill, type MobilePrPrefill } from '../../source-control/mobile-pr-create'
import { fetchWorktreeLinkedPR } from '../../source-control/mobile-pr-link'
import { openMobilePrUrl } from '../MobilePrComposeSheet'
import { MobilePrComposeForm } from './MobilePrComposeForm'
import { MobileLinkPrForm } from './MobileLinkPrForm'
import { prCreateEmptyStateStyles as styles } from './pr-create-empty-state-styles'

type Props = {
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  // Refetches the sidebar after create or an explicit empty-state refresh.
  onCreated: () => void
}

type Mode = 'choose' | 'create' | 'link'

// Empty state for a branch with no PR: create a new PR, or link an existing one
// (the no-PR surface is the natural home for linking — desktop's link entry lives
// on its PR card, but on mobile this is where a user lands with nothing linked).
export function PrSidebarCreateEmptyState({ client, worktreeId, gitBranch, onCreated }: Props) {
  const [prefill, setPrefill] = useState<MobilePrPrefill | null>(null)
  const [mode, setMode] = useState<Mode>('choose')
  const [loading, setLoading] = useState(false)
  const [createWarning, setCreateWarning] = useState<string | null>(null)
  // A persisted linkedPR while the branch shows no PR means the linked PR could
  // not be resolved. Mention it while still allowing the user to relink.
  const [orphanLinkedPR, setOrphanLinkedPR] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!client) {
      setOrphanLinkedPR(null)
      return
    }
    void fetchWorktreeLinkedPR(client, worktreeId)
      .then((n) => {
        if (!cancelled) {
          setOrphanLinkedPR(n)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOrphanLinkedPR(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, worktreeId])

  const openComposer = async (): Promise<void> => {
    if (!client || loading) {
      return
    }
    setCreateWarning(null)
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
    } catch {
      // Best-effort: if prefill resolution rejects, leave the empty state so the
      // user can retry rather than surfacing an unhandled rejection.
    } finally {
      setLoading(false)
    }
  }

  const canCreate = !!client && !!gitBranch

  if (mode === 'create' && prefill) {
    return (
      <View style={styles.composerArea}>
        <MobilePrComposeForm
          client={client}
          worktreeId={worktreeId}
          prefill={prefill}
          head={gitBranch}
          onCancel={() => setMode('choose')}
          onCreated={(url, warning) => {
            setMode('choose')
            setCreateWarning(warning ?? null)
            openMobilePrUrl(url)
            onCreated()
          }}
        />
      </View>
    )
  }

  if (mode === 'link') {
    return (
      <View style={styles.composerArea}>
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
    <View style={styles.section}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <GitPullRequestArrow size={14} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.headerLabel}>Pull request</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            onPress={onCreated}
            accessibilityRole="button"
            accessibilityLabel="Refresh pull request"
            hitSlop={6}
          >
            <RefreshCw size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <Pressable
            style={[styles.createButton, (!canCreate || loading) && styles.createButtonDisabled]}
            onPress={() => void openComposer()}
            disabled={!canCreate || loading}
            accessibilityRole="button"
            accessibilityLabel="Create pull request"
          >
            {loading ? (
              <ActivityIndicator color={colors.bgBase} />
            ) : (
              <GitPullRequestArrow size={14} color={colors.bgBase} strokeWidth={2.2} />
            )}
            <Text style={styles.createButtonText}>Create PR</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.body}>
        <Text style={styles.bodyTitle}>
          {orphanLinkedPR ? `Linked PR #${orphanLinkedPR} unavailable` : 'No open pull request'}
        </Text>
        <Text style={styles.bodyText}>
          {orphanLinkedPR
            ? 'Refresh to check again, or create a new PR for this branch.'
            : gitBranch
              ? `${gitBranch} is not linked to an open PR.`
              : 'The current branch is not linked to an open PR.'}
        </Text>
        {createWarning ? <Text style={styles.bodyText}>{createWarning}</Text> : null}
        <Pressable
          style={({ pressed }) => [
            styles.linkButton,
            !client && styles.linkButtonDisabled,
            pressed && styles.linkButtonPressed
          ]}
          onPress={() => setMode('link')}
          disabled={!client}
          accessibilityRole="button"
          accessibilityLabel="Link an existing pull request"
          accessibilityState={{ disabled: !client }}
          hitSlop={6}
        >
          <Link2
            size={14}
            color={client ? colors.textSecondary : colors.textMuted}
            strokeWidth={2.2}
          />
          <Text style={styles.linkButtonText}>Link an existing PR</Text>
        </Pressable>
      </View>
    </View>
  )
}
