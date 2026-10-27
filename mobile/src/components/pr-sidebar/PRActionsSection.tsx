import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge, Link2Off } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { GitHubPRMergeMethod, PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { ConfirmModal } from '../ConfirmModal'
import { resolveGitHubPRMergeMethods } from '../../../../src/shared/github/pull-request-merge-methods'
import { MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY } from '../../../../src/shared/source-control-runtime-capabilities'
import { useRouteCapability } from '../../transport/use-workspace-client'
import { presentPrMerge, resolvePrActionAvailability } from './pr-actions-state'
import { prActionsStyles as styles } from './pr-actions-styles'

type Props = {
  pr: PRInfo
  actions: MobilePrActions
  client: RpcClient | null
  worktreeId: string
  // Refetch after unlinking so the view returns to the create/link empty state.
  onUnlinked: () => void
  onRecheck: () => void
}

type Confirm =
  | { kind: 'merge'; method: GitHubPRMergeMethod }
  | { kind: 'state'; state: 'open' | 'closed' }

// Merge leads; Close/Reopen+Unlink share secondary row. Self-explanatory buttons need no mobile section header.
export function PRActionsSection({
  pr,
  actions,
  client,
  worktreeId,
  onUnlinked,
  onRecheck
}: Props) {
  useMobileColorScheme()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  // Local unlink errors — unlink is not routed through the actions engine.
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  // Use repo’s default merge method to keep mobile one-tap without narrow method picker.
  const mergeMethods = resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null)
  const effectiveMethod = mergeMethods.defaultMethod
  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const avail = resolvePrActionAvailability(state)
  const merge = presentPrMerge(
    { ...pr, state, autoMergeEnabled: autoMerge || pr.autoMergeEnabled === true },
    effectiveMethod
  )
  // Older hosts, or an older desktop relaying to a server, reject this method from mobile.
  const routeCanMarkReady = useRouteCapability(MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY)
  const showMarkReady = avail.canMarkReady && routeCanMarkReady
  const mergeBusy = actions.isBusy({ kind: 'merge' })
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const stateBusy = actions.isBusy({ kind: 'state' })
  const unlinkBusy = unlinking || mergeBusy || autoMergeBusy || stateBusy
  const showAutoMerge = merge.showAutoMerge
  const showSecondary = avail.canClose || avail.canReopen || avail.canUnlink
  const actionError = unlinkError ?? actions.error

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking) {
      return
    }
    setUnlinking(true)
    setUnlinkError(null)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId, pr.number)
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
  }, [client, onUnlinked, pr.number, unlinking, worktreeId])

  const confirmCopy = (): { title: string; message: string; confirmLabel: string } => {
    if (confirm?.kind === 'merge') {
      return {
        title: 'Merge pull request?',
        message: merge.confirmMessage,
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
            (mergeBusy || !merge.enabled) && styles.actionButtonDisabled
          ]}
          onPress={() => {
            setUnlinkError(null)
            setConfirm({ kind: 'merge', method: effectiveMethod })
          }}
          disabled={mergeBusy || !merge.enabled}
          accessibilityRole="button"
          accessibilityLabel="Merge pull request"
          accessibilityHint={merge.hint ?? undefined}
        >
          {mergeBusy ? (
            <ActivityIndicator color={colors.onMergeGreen} />
          ) : (
            <GitMerge size={16} color={colors.onMergeGreen} strokeWidth={2.2} />
          )}
          <Text style={[styles.actionButtonText, styles.actionButtonTextMerge]}>{merge.label}</Text>
        </Pressable>
      ) : null}
      {avail.canMerge && merge.hint ? (
        <View style={styles.hintRow}>
          <Text style={styles.actionHint}>{merge.hint}</Text>
          {/* No mobile surface polls PR state, so a blocked Merge needs its own recheck. */}
          <Pressable
            onPress={() => onRecheck()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Recheck merge status"
          >
            <Text style={styles.recheckText}>Recheck</Text>
          </Pressable>
        </View>
      ) : null}

      {showMarkReady ? (
        <Pressable
          style={[
            styles.actionButton,
            styles.secondaryButton,
            stateBusy && styles.actionButtonDisabled
          ]}
          onPress={() => {
            setUnlinkError(null)
            actions.markReadyForReview()
          }}
          disabled={stateBusy}
          accessibilityRole="button"
          accessibilityLabel="Mark pull request ready for review"
        >
          {stateBusy ? <ActivityIndicator color={colors.textSecondary} /> : null}
          <Text style={styles.actionButtonText}>Ready for review</Text>
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
