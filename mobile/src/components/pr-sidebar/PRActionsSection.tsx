import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge, Link2Off } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubPRMergeMethod, PRInfo } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { ConfirmModal } from '../ConfirmModal'
import { canShowMobilePRAutoMergeControl } from './pr-auto-merge-availability'
import { resolveMobilePrMergeMethod, resolvePrActionAvailability } from './pr-actions-state'
import { prActionsStyles as styles } from './pr-actions-styles'

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

// Merge primary; Close/Reopen + Unlink share one secondary row. No section title —
// button labels are self-explanatory and a header wasted a full row on mobile.
export function PRActionsSection({ pr, actions, client, worktreeId, onUnlinked }: Props) {
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  // Local unlink errors — unlink is not routed through the actions engine.
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  // Mobile keeps merge one-tap: use the repo default instead of surfacing a
  // desktop-style method picker in the narrow PR action stack.
  const effectiveMethod = resolveMobilePrMergeMethod(pr.mergeMethodSettings)
  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const avail = resolvePrActionAvailability(state)
  const mergeBusy = actions.isBusy({ kind: 'merge' })
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const stateBusy = actions.isBusy({ kind: 'state' })
  const unlinkBusy = unlinking || mergeBusy || autoMergeBusy || stateBusy
  const showAutoMerge =
    avail.canAutoMerge &&
    canShowMobilePRAutoMergeControl({
      ...pr,
      autoMergeEnabled: autoMerge || pr.autoMergeEnabled === true
    })
  const showSecondary = avail.canClose || avail.canReopen || avail.canUnlink
  const actionError = unlinkError ?? actions.error

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking) {
      return
    }
    setUnlinking(true)
    setUnlinkError(null)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId)
      if (outcome.ok) {
        onUnlinked()
      } else {
        setUnlinkError(outcome.error)
      }
    } catch (err) {
      setUnlinkError(err instanceof Error ? err.message : 'Failed to unlink pull request.')
    } finally {
      setUnlinking(false)
    }
  }, [client, onUnlinked, unlinking, worktreeId])

  const confirmCopy = (): { title: string; message: string; confirmLabel: string } => {
    if (confirm?.kind === 'merge') {
      return {
        title: 'Merge pull request?',
        message: `This will merge #${pr.number} into its base branch.`,
        confirmLabel: 'Merge'
      }
    }
    if (confirm?.kind === 'state' && confirm.state === 'closed') {
      return {
        title: 'Close pull request?',
        message: `#${pr.number} will be closed without merging.`,
        confirmLabel: 'Close'
      }
    }
    return {
      title: 'Reopen pull request?',
      message: `#${pr.number} will be reopened.`,
      confirmLabel: 'Reopen'
    }
  }

  const runConfirmed = (): void => {
    if (!confirm) {
      return
    }
    // Engine errors take over the shared error line after this; drop unlink text.
    setUnlinkError(null)
    if (confirm.kind === 'merge') {
      actions.merge(confirm.method)
    } else {
      actions.updateState(confirm.state)
    }
  }

  const copy = confirmCopy()

  return (
    <View style={styles.actionsBlock}>
      {avail.canMerge ? (
        <Pressable
          style={[
            styles.actionButton,
            styles.actionButtonMerge,
            mergeBusy && styles.actionButtonDisabled
          ]}
          onPress={() => {
            setUnlinkError(null)
            setConfirm({ kind: 'merge', method: effectiveMethod })
          }}
          disabled={mergeBusy}
          accessibilityRole="button"
          accessibilityLabel="Merge pull request"
        >
          {mergeBusy ? (
            <ActivityIndicator color={colors.onMergeGreen} />
          ) : (
            <GitMerge size={16} color={colors.onMergeGreen} strokeWidth={2.2} />
          )}
          <Text style={[styles.actionButtonText, styles.actionButtonTextMerge]}>
            Merge pull request
          </Text>
        </Pressable>
      ) : null}

      {showAutoMerge ? (
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Auto-merge when ready</Text>
          <Pressable
            style={[styles.togglePill, autoMerge && styles.togglePillOn]}
            onPress={() => {
              setUnlinkError(null)
              actions.setAutoMerge(!autoMerge, effectiveMethod)
            }}
            disabled={autoMergeBusy}
            accessibilityRole="switch"
            accessibilityState={{ checked: autoMerge }}
            accessibilityLabel="Toggle auto-merge"
          >
            {autoMergeBusy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Text style={[styles.togglePillText, autoMerge && styles.togglePillTextOn]}>
                {autoMerge ? 'On' : 'Off'}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {showSecondary ? (
        <View style={styles.secondaryRow}>
          {avail.canClose || avail.canReopen ? (
            <Pressable
              style={[
                styles.actionButton,
                styles.secondaryButton,
                stateBusy && styles.actionButtonDisabled
              ]}
              onPress={() => {
                setUnlinkError(null)
                setConfirm({ kind: 'state', state: avail.canClose ? 'closed' : 'open' })
              }}
              disabled={stateBusy}
              accessibilityRole="button"
              accessibilityLabel={avail.canClose ? 'Close pull request' : 'Reopen pull request'}
            >
              {stateBusy ? <ActivityIndicator color={colors.textSecondary} /> : null}
              <Text
                style={[
                  styles.actionButtonText,
                  avail.canClose && styles.actionButtonDestructiveText
                ]}
              >
                {avail.canClose ? 'Close' : 'Reopen'}
              </Text>
            </Pressable>
          ) : null}
          {avail.canUnlink ? (
            <Pressable
              style={[
                styles.actionButton,
                styles.secondaryButton,
                unlinkBusy && styles.actionButtonDisabled
              ]}
              onPress={() => void unlink()}
              disabled={unlinkBusy}
              accessibilityRole="button"
              accessibilityLabel="Unlink pull request"
            >
              {unlinking ? (
                <ActivityIndicator color={colors.textSecondary} />
              ) : (
                <Link2Off size={16} color={colors.textSecondary} strokeWidth={2.2} />
              )}
              <Text style={styles.actionButtonText}>Unlink</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

      <ConfirmModal
        visible={confirm !== null}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirmLabel}
        destructive={confirm?.kind === 'state' && confirm.state === 'closed'}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </View>
  )
}
