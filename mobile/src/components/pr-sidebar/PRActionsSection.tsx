import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubPRMergeMethod, PRInfo } from '../../../../src/shared/types'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { ConfirmModal } from '../ConfirmModal'
import { PRSection } from './PRSection'
import { prActionsStyles as styles } from './pr-actions-styles'

type Props = {
  pr: PRInfo
  actions: MobilePrActions
}

const MERGE_METHODS: { method: GitHubPRMergeMethod; label: string }[] = [
  { method: 'merge', label: 'Merge' },
  { method: 'squash', label: 'Squash' },
  { method: 'rebase', label: 'Rebase' }
]

type Confirm =
  | { kind: 'merge'; method: GitHubPRMergeMethod }
  | { kind: 'state'; state: 'open' | 'closed' }

// Merge (with method picker), auto-merge toggle, and close/reopen. Destructive
// actions route through ConfirmModal first (R5). The firing row shows a spinner
// in place of its icon and disables; other rows stay interactive (uniform visual).
export function PRActionsSection({ pr, actions }: Props) {
  // Default merge method from the PR's repo settings, else 'squash' (host default).
  const [method, setMethod] = useState<GitHubPRMergeMethod>(
    pr.mergeMethodSettings?.defaultMethod ?? 'squash'
  )
  const [confirm, setConfirm] = useState<Confirm | null>(null)

  // Only offer methods the repo allows; selecting a disabled method would make the
  // merge fail. Fall back to all methods when the repo settings are unknown.
  const availableMethods = useMemo(() => {
    const allowed = pr.mergeMethodSettings?.allowedMethods
    if (!allowed) {
      return MERGE_METHODS
    }
    const filtered = MERGE_METHODS.filter((m) => allowed[m.method])
    return filtered.length > 0 ? filtered : MERGE_METHODS
  }, [pr.mergeMethodSettings])
  // Keep the active method valid even if the default isn't an allowed option.
  const effectiveMethod = availableMethods.some((m) => m.method === method)
    ? method
    : availableMethods[0].method

  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const isOpen = state === 'open' || state === 'draft'
  const mergeBusy = actions.isBusy({ kind: 'merge' })
  const autoMergeBusy = actions.isBusy({ kind: 'autoMerge' })
  const stateBusy = actions.isBusy({ kind: 'state' })

  const confirmCopy = (): { title: string; message: string; confirmLabel: string } => {
    if (confirm?.kind === 'merge') {
      return {
        title: `${methodLabel(confirm.method)} pull request?`,
        message: `This will ${confirm.method} #${pr.number} into its base branch.`,
        confirmLabel: methodLabel(confirm.method)
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
    if (confirm.kind === 'merge') {
      actions.merge(confirm.method)
    } else {
      actions.updateState(confirm.state)
    }
  }

  const copy = confirmCopy()

  return (
    <PRSection title="Actions">
      {/* Merge-method picker: one-step selection, then a single Merge CTA. */}
      <View style={styles.methodRow}>
        {availableMethods.map((m) => {
          const selected = m.method === effectiveMethod
          return (
            <Pressable
              key={m.method}
              style={[styles.methodButton, selected && styles.methodButtonSelected]}
              onPress={() => setMethod(m.method)}
              disabled={mergeBusy}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${m.label} merge method`}
            >
              <Text style={[styles.methodButtonText, selected && styles.methodButtonTextSelected]}>
                {m.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Pressable
        style={[
          styles.actionButton,
          styles.actionButtonPrimary,
          (mergeBusy || !isOpen) && styles.actionButtonDisabled
        ]}
        onPress={() => setConfirm({ kind: 'merge', method: effectiveMethod })}
        disabled={mergeBusy || !isOpen}
        accessibilityRole="button"
        accessibilityLabel={`${methodLabel(effectiveMethod)} pull request`}
      >
        {mergeBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <GitMerge size={16} color="#fff" strokeWidth={2.2} />
        )}
        <Text style={[styles.actionButtonText, styles.actionButtonTextPrimary]}>
          {methodLabel(effectiveMethod)}
        </Text>
      </Pressable>

      {/* Auto-merge toggle — optimistic, reverts on transient failure. */}
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Auto-merge when ready</Text>
        <Pressable
          style={[styles.togglePill, autoMerge && styles.togglePillOn]}
          onPress={() => actions.setAutoMerge(!autoMerge, effectiveMethod)}
          disabled={autoMergeBusy || !isOpen}
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

      {/* Close / reopen — confirmed before firing (R5). */}
      <Pressable
        style={[styles.actionButton, stateBusy && styles.actionButtonDisabled]}
        onPress={() => setConfirm({ kind: 'state', state: isOpen ? 'closed' : 'open' })}
        disabled={stateBusy}
        accessibilityRole="button"
        accessibilityLabel={isOpen ? 'Close pull request' : 'Reopen pull request'}
      >
        {stateBusy ? <ActivityIndicator color={colors.textSecondary} /> : null}
        <Text style={[styles.actionButtonText, isOpen && styles.actionButtonDestructiveText]}>
          {isOpen ? 'Close' : 'Reopen'}
        </Text>
      </Pressable>

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

function methodLabel(method: GitHubPRMergeMethod): string {
  switch (method) {
    case 'merge':
      return 'Merge'
    case 'squash':
      return 'Squash'
    case 'rebase':
      return 'Rebase'
  }
}
