import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { GitMerge, Link2Off } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubPRMergeMethod, PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { unlinkMobilePr } from '../../source-control/mobile-pr-link'
import { triggerError, triggerSelection, triggerSuccess } from '../../platform/haptics'
import { ConfirmModal } from '../ConfirmModal'
import { MobileSwitch } from '../MobileSwitch'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ListGroup } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { canShowGitHubPRAutoMergeControl } from '../../../../src/shared/github/pull-request-auto-merge-availability'
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
  | { kind: 'unlink' }

const MERGE_LABEL: Record<GitHubPRMergeMethod, string> = {
  merge: 'Create merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

const MERGE_VERB: Record<GitHubPRMergeMethod, string> = {
  merge: 'merged into',
  squash: 'squashed into',
  rebase: 'rebased onto'
}

// The engine's mutations are fire-and-forget, so success and failure are read off the busy flag settling.
function useSettledHaptic(busy: boolean, error: string | null, successHaptic: boolean): void {
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      if (error) {
        triggerError()
      } else if (successHaptic) {
        triggerSuccess()
      }
    }
    wasBusy.current = busy
  }, [busy, error, successHaptic])
}

// Merge is the screen's one primary; auto-merge is a switch row; Close/Reopen and Unlink are secondary.
export function PRActionsSection({ pr, actions, client, worktreeId, onUnlinked }: Props) {
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  // Local unlink errors — unlink is not routed through the actions engine.
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  // Mobile keeps merge one-tap: use the repo default instead of surfacing a
  // desktop-style method picker in the narrow PR action stack.
  const effectiveMethod = resolveMobilePrMergeMethod(pr.mergeMethodSettings)
  // Name the method only when the host told us the repo's settings; otherwise it is a guess.
  const methodKnown = pr.mergeMethodSettings !== undefined
  const mergeLabel = methodKnown ? MERGE_LABEL[effectiveMethod] : 'Merge pull request'
  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const avail = resolvePrActionAvailability(state)
  const mergeBusy = actions.isBusy({ kind: 'merge' })
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const stateBusy = actions.isBusy({ kind: 'state' })
  const unlinkBusy = unlinking || mergeBusy || autoMergeBusy || stateBusy
  const showAutoMerge =
    avail.canAutoMerge &&
    canShowGitHubPRAutoMergeControl({
      ...pr,
      autoMergeEnabled: autoMerge || pr.autoMergeEnabled === true
    })
  const showSecondary = avail.canClose || avail.canReopen || avail.canUnlink
  const actionError = unlinkError ?? actions.error

  useSettledHaptic(mergeBusy, actions.error, true)
  useSettledHaptic(stateBusy, actions.error, true)
  // The switch already gave a selection tick when flipped.
  useSettledHaptic(autoMergeBusy, actions.error, false)

  const unlink = useCallback(async (): Promise<void> => {
    if (!client || unlinking) {
      return
    }
    setUnlinking(true)
    setUnlinkError(null)
    try {
      const outcome = await unlinkMobilePr(client, worktreeId)
      if (outcome.ok) {
        triggerSuccess()
        onUnlinked()
      } else {
        triggerError()
        setUnlinkError(outcome.error)
      }
    } catch (err) {
      triggerError()
      setUnlinkError(err instanceof Error ? err.message : 'Failed to unlink pull request.')
    } finally {
      setUnlinking(false)
    }
  }, [client, onUnlinked, unlinking, worktreeId])

  const confirmCopy = (): { title: string; message: string; confirmLabel: string } => {
    if (confirm?.kind === 'merge') {
      const base = pr.baseRefName ?? 'its base branch'
      return {
        title: `${mergeLabel}?`,
        message: methodKnown
          ? `#${pr.number} will be ${MERGE_VERB[confirm.method]} ${base}.`
          : `This will merge #${pr.number} into ${base}.`,
        confirmLabel: methodKnown ? mergeLabel : 'Merge'
      }
    }
    if (confirm?.kind === 'unlink') {
      return {
        title: 'Unlink pull request?',
        message: `#${pr.number} stays open on GitHub; this workspace stops tracking it.`,
        confirmLabel: 'Unlink'
      }
    }
    if (confirm?.kind === 'state' && confirm.state === 'closed') {
      return {
        title: 'Close pull request?',
        message: `#${pr.number} will be closed without merging.`,
        confirmLabel: 'Close pull request'
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
    } else if (confirm.kind === 'unlink') {
      void unlink()
    } else {
      actions.updateState(confirm.state)
    }
  }

  const copy = confirmCopy()

  return (
    <View style={styles.actionsBlock}>
      <View style={styles.actionsInset}>
        {avail.canMerge ? (
          <Button
            label={mergeLabel}
            variant="primary"
            icon={GitMerge}
            block
            busy={mergeBusy}
            onPress={() => {
              setUnlinkError(null)
              setConfirm({ kind: 'merge', method: effectiveMethod })
            }}
            accessibilityLabel="Merge pull request"
          />
        ) : null}

        {showAutoMerge ? (
          <ListGroup style={styles.autoMergeGroup}>
            <ListRow
              title="Auto-merge when ready"
              subtitle="Merges once checks and reviews pass."
              accessory={
                autoMergeBusy ? (
                  <ActivityIndicator color={colors.textSecondary} />
                ) : (
                  <MobileSwitch
                    value={autoMerge}
                    onValueChange={(next) => {
                      triggerSelection()
                      setUnlinkError(null)
                      actions.setAutoMerge(next, effectiveMethod)
                    }}
                    accessibilityLabel="Toggle auto-merge"
                  />
                )
              }
            />
          </ListGroup>
        ) : null}

        {showSecondary ? (
          <View style={styles.secondaryRow}>
            {avail.canClose || avail.canReopen ? (
              <Button
                label={avail.canClose ? 'Close' : 'Reopen'}
                variant={avail.canClose ? 'destructive' : 'secondary'}
                size="compact"
                block
                style={styles.secondaryButton}
                accessibilityLabel={avail.canClose ? 'Close pull request' : 'Reopen pull request'}
                busy={stateBusy}
                onPress={() => {
                  setUnlinkError(null)
                  setConfirm({ kind: 'state', state: avail.canClose ? 'closed' : 'open' })
                }}
              />
            ) : null}
            {avail.canUnlink ? (
              <Button
                label="Unlink"
                icon={Link2Off}
                size="compact"
                block
                style={styles.secondaryButton}
                busy={unlinking}
                disabled={unlinkBusy && !unlinking}
                onPress={() => {
                  setUnlinkError(null)
                  setConfirm({ kind: 'unlink' })
                }}
                accessibilityLabel="Unlink pull request"
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {actionError ? <Banner tone="error" message={actionError} /> : null}

      <ConfirmModal
        visible={confirm !== null}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirmLabel}
        destructive={
          confirm?.kind === 'unlink' || (confirm?.kind === 'state' && confirm.state === 'closed')
        }
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </View>
  )
}
