import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge, Link2Off } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubPRMergeMethod, PRInfo } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { ConfirmModal } from '../ConfirmModal'
import { PRSection } from './PRSection'
import { canShowMobilePRAutoMergeControl } from './pr-auto-merge-availability'
import { resolveMobilePrMergeMethod, resolvePrActionAvailability } from './pr-actions-state'
import { prActionsStyles as styles } from './pr-actions-styles'
import { useTranslate } from '../../i18n/useTranslate'

type Props = {
  pr: PRInfo
  actions: MobilePrActions
  client: RpcClient | null
  worktreeId: string
  // Refetch after unlinking so the view returns to the create/link empty state.
  onUnlinked: () => void
}

type Confirm =
  | { kind: 'merge'; method: GitHubPRMergeMethod }
  | { kind: 'state'; state: 'open' | 'closed' }

// Merge, auto-merge toggle, and close/reopen. Destructive actions route through
// ConfirmModal first (R5). The firing row shows a spinner in place of its icon
// and disables; other rows stay interactive (uniform visual).
export function PRActionsSection({ pr, actions, client, worktreeId, onUnlinked }: Props) {
  const { t } = useTranslate()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  // Mobile keeps merge one-tap: use the repo default instead of surfacing a
  // desktop-style method picker in the narrow PR action stack.
  const effectiveMethod = resolveMobilePrMergeMethod(pr.mergeMethodSettings)
  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const avail = resolvePrActionAvailability(state)
  const mergeBusy = actions.isBusy({ kind: 'merge' })
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const stateBusy = actions.isBusy({ kind: 'state' })
  const showAutoMerge =
    avail.canAutoMerge &&
    canShowMobilePRAutoMergeControl({
      ...pr,
      autoMergeEnabled: autoMerge || pr.autoMergeEnabled === true
    })

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking) {
      return
    }
    setUnlinking(true)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId)
      if (outcome.ok) {
        onUnlinked()
      }
    } finally {
      setUnlinking(false)
    }
  }, [client, onUnlinked, unlinking, worktreeId])

  const confirmCopy = (): { title: string; message: string; confirmLabel: string } => {
    if (confirm?.kind === 'merge') {
      return {
        title: t('mobile.prActions.mergeConfirmTitle', 'Merge pull request?'),
        message: t(
          'mobile.prActions.mergeConfirmMessage',
          'This will merge #{{number}} into its base branch.',
          { number: pr.number }
        ),
        confirmLabel: t('mobile.prActions.mergeConfirmLabel', 'Merge')
      }
    }
    if (confirm?.kind === 'state' && confirm.state === 'closed') {
      return {
        title: t('mobile.prActions.closeConfirmTitle', 'Close pull request?'),
        message: t(
          'mobile.prActions.closeConfirmMessage',
          '#{{number}} will be closed without merging.',
          { number: pr.number }
        ),
        confirmLabel: t('mobile.prActions.closeConfirmLabel', 'Close')
      }
    }
    return {
      title: t('mobile.prActions.reopenConfirmTitle', 'Reopen pull request?'),
      message: t('mobile.prActions.reopenConfirmMessage', '#{{number}} will be reopened.', {
        number: pr.number
      }),
      confirmLabel: t('mobile.prActions.reopenConfirmLabel', 'Reopen')
    }
  }

  const runConfirmed = (): void => {
    if (!confirm) {
      return
    }
    if (confirm.kind === 'merge') {
      actions.merge(confirm.method)
    } else {
      actions.updateState(confirm.state)
    }
  }

  const copy = confirmCopy()

  return (
    <PRSection title={t('mobile.prActions.title', 'Actions')}>
      {/* Merge controls only while the PR can still be merged (open/draft). */}
      {avail.canMerge ? (
        <Pressable
          style={[
            styles.actionButton,
            styles.actionButtonMerge,
            mergeBusy && styles.actionButtonDisabled
          ]}
          onPress={() => setConfirm({ kind: 'merge', method: effectiveMethod })}
          disabled={mergeBusy}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.prActions.merge', 'Merge pull request')}
        >
          {mergeBusy ? (
            <ActivityIndicator color={colors.onMergeGreen} />
          ) : (
            <GitMerge size={16} color={colors.onMergeGreen} strokeWidth={2.2} />
          )}
          <Text style={[styles.actionButtonText, styles.actionButtonTextMerge]}>
            {t('mobile.prActions.merge', 'Merge pull request')}
          </Text>
        </Pressable>
      ) : null}

      {/* Auto-merge toggle — optimistic, reverts on transient failure. */}
      {showAutoMerge ? (
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>
            {t('mobile.prActions.autoMergeLabel', 'Auto-merge when ready')}
          </Text>
          <Pressable
            style={[styles.togglePill, autoMerge && styles.togglePillOn]}
            onPress={() => actions.setAutoMerge(!autoMerge, effectiveMethod)}
            disabled={autoMergeBusy}
            accessibilityRole="switch"
            accessibilityState={{ checked: autoMerge }}
            accessibilityLabel={t('mobile.prActions.toggleAutoMerge', 'Toggle auto-merge')}
          >
            {autoMergeBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Text style={[styles.togglePillText, autoMerge && styles.togglePillTextOn]}>
                {autoMerge ? t('mobile.prActions.on', 'On') : t('mobile.prActions.off', 'Off')}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {/* Close (open PRs) / Reopen (closed PRs) — confirmed before firing (R5). */}
      {avail.canClose || avail.canReopen ? (
        <Pressable
          style={[styles.actionButton, stateBusy && styles.actionButtonDisabled]}
          onPress={() => setConfirm({ kind: 'state', state: avail.canClose ? 'closed' : 'open' })}
          disabled={stateBusy}
          accessibilityRole="button"
          accessibilityLabel={
            avail.canClose
              ? t('mobile.prActions.closePullRequest', 'Close pull request')
              : t('mobile.prActions.reopenPullRequest', 'Reopen pull request')
          }
        >
          {stateBusy ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <Text
            style={[styles.actionButtonText, avail.canClose && styles.actionButtonDestructiveText]}
          >
            {avail.canClose
              ? t('mobile.prActions.close', 'Close')
              : t('mobile.prActions.reopen', 'Reopen')}
          </Text>
        </Pressable>
      ) : null}

      {/* Unlink the PR from this worktree. Disabled while another PR mutation is in
          flight so clearing the link can't race a merge/close refetch. */}
      {avail.canUnlink ? (
        <Pressable
          style={[
            styles.actionButton,
            (unlinking || mergeBusy || autoMergeBusy || stateBusy) && styles.actionButtonDisabled
          ]}
          onPress={() => void unlink()}
          disabled={unlinking || mergeBusy || autoMergeBusy || stateBusy}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.prActions.unlinkPullRequest', 'Unlink pull request')}
        >
          {unlinking ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : (
            <Link2Off size={16} color={colors.textSecondary} strokeWidth={2.2} />
          )}
          <Text style={styles.actionButtonText}>{t('mobile.prActions.unlink', 'Unlink')}</Text>
        </Pressable>
      ) : null}

      {actions.error ? <Text style={styles.actionError}>{actions.error}</Text> : null}

      {/* A Modal is taken out of the flex flow, so it adds no body gap here. */}
      <ConfirmModal
        visible={confirm !== null}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirmLabel}
        destructive={confirm?.kind === 'state' && confirm.state === 'closed'}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </PRSection>
  )
}
