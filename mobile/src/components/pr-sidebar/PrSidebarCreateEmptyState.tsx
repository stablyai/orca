import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitPullRequestArrow, Link2, RefreshCw } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc-client'
import type { ConnectionState } from '../../transport/types'
import type { MobileGitStatusResult } from '../../source-control/mobile-git-status'
import {
  getMobileCommitFailureStagedEntries,
  type MobileCommitFailureRecovery
} from '../../source-control/mobile-commit-failure-recovery'
import { useMobileCommitFailureRecovery } from '../../source-control/use-mobile-commit-failure-recovery'
import { MobileCommitFailurePanel } from '../../source-control/MobileCommitFailurePanel'
import { mobileHostedReviewCreateIntentProgressMessage } from '../../source-control/mobile-hosted-review-create-intent'
import type { MobileHostedReviewCreateIntentProgress } from '../../source-control/mobile-hosted-review-create-intent'
import {
  isMobileHostedReviewCommitFailure,
  runMobileHostedReviewCreateIntent
} from '../../source-control/mobile-hosted-review-create-intent-runner'
import { fetchWorktreeLinkedPR } from '../../source-control/mobile-pr-link'
import { openMobilePrUrl } from '../MobilePrComposeSheet'
import { MobileLinkPrForm } from './MobileLinkPrForm'
import { prCreateEmptyStateStyles as styles } from './pr-create-empty-state-styles'

type Props = {
  client: RpcClient | null
  worktreeId: string
  gitBranch: string | null
  gitStatus: MobileGitStatusResult | null
  connState: ConnectionState
  // Refetches the sidebar after create or an explicit empty-state refresh.
  onCreated: () => void
}

type Mode = 'choose' | 'link'

// Empty state for a branch with no PR: create a new PR, or link an existing one
// (the no-PR surface is the natural home for linking — desktop's link entry lives
// on its PR card, but on mobile this is where a user lands with nothing linked).
export function PrSidebarCreateEmptyState({
  client,
  worktreeId,
  gitBranch,
  gitStatus,
  connState,
  onCreated
}: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [loading, setLoading] = useState(false)
  const [createWarning, setCreateWarning] = useState<string | null>(null)
  const [commitFailureRecovery, setCommitFailureRecovery] =
    useState<MobileCommitFailureRecovery | null>(null)
  // A persisted linkedPR while the branch shows no PR means the linked PR could
  // not be resolved. Mention it while still allowing the user to relink.
  const [orphanLinkedPR, setOrphanLinkedPR] = useState<number | null>(null)
  const commitFailureRecoveryAction = useMobileCommitFailureRecovery({
    client,
    connState,
    worktreeId,
    failure: commitFailureRecovery
  })

  const refreshPrState = () => {
    setCreateWarning(null)
    setCommitFailureRecovery(null)
    onCreated()
  }

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
    setCommitFailureRecovery(null)
    setLoading(true)
    try {
      if (!gitBranch) {
        setCreateWarning('Check out a branch before creating a pull request.')
        return
      }
      // Why: mobile skips the local compose step here and runs the hosted create
      // flow directly so PR creation matches the automated hosted-review path.
      let progress: MobileHostedReviewCreateIntentProgress | null = null
      const outcome = await runMobileHostedReviewCreateIntent(client, worktreeId, {
        branch: gitBranch,
        title: gitBranch,
        status: gitStatus,
        onProgress: (nextProgress) => {
          progress = nextProgress
          setCreateWarning(mobileHostedReviewCreateIntentProgressMessage(nextProgress))
        }
      })
      if (!outcome.ok) {
        if (isMobileHostedReviewCommitFailure(outcome, progress)) {
          const outcomeStagedEntries = getMobileCommitFailureStagedEntries(outcome.status?.entries)
          setCommitFailureRecovery({
            error: outcome.error,
            commitMessage: outcome.commitMessage ?? gitBranch,
            stagedEntries:
              outcomeStagedEntries.length > 0
                ? outcomeStagedEntries
                : getMobileCommitFailureStagedEntries(gitStatus?.entries)
          })
        }
        setCreateWarning(outcome.error)
        return
      }
      setCreateWarning(outcome.warning ?? null)
      openMobilePrUrl(outcome.url)
      onCreated()
    } catch (err) {
      setCreateWarning(err instanceof Error ? err.message : 'Failed to create pull request.')
    } finally {
      setLoading(false)
    }
  }

  const canCreate = !!client && !!gitBranch

  if (mode === 'link') {
    return (
      <View style={styles.composerArea}>
        <MobileLinkPrForm
          client={client}
          worktreeId={worktreeId}
          onCancel={() => setMode('choose')}
          onLinked={() => {
            setMode('choose')
            refreshPrState()
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
            onPress={refreshPrState}
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
        {commitFailureRecovery ? (
          <MobileCommitFailurePanel
            failure={commitFailureRecovery}
            action={commitFailureRecoveryAction}
          />
        ) : createWarning ? (
          <Text style={styles.bodyText}>{createWarning}</Text>
        ) : null}
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
