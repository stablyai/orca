import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { IconButton } from '../components/ui/IconButton'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/ui/ListGroup'
import { pressTransition } from '../components/ui/transition-styles'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerMediumImpact } from '../platform/haptics'
import { Check, Copy, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react-native'
import { colors, motion, spacing, textStyles, typography } from '../theme/mobile-theme'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import {
  getQuickCommandDisplayPreview,
  getTerminalQuickCommandBody,
  isAgentQuickCommand
} from '../terminal/quick-commands'

type QuickCommandRowProps = {
  command: TerminalQuickCommand
  onLaunch: (command: TerminalQuickCommand) => void
  onEdit: (command: TerminalQuickCommand) => void
  onDelete: (command: TerminalQuickCommand) => void
  disabled: boolean
}

type CopyFeedback = {
  body: string
  status: 'copied' | 'failed'
}

export function QuickCommandRow({
  command,
  onLaunch,
  onEdit,
  onDelete,
  disabled
}: QuickCommandRowProps) {
  const clipboard = useClipboardWriter()
  const isAgent = isAgentQuickCommand(command)
  const body = getTerminalQuickCommandBody(command)
  const canCopy = body.trim().length > 0
  // Why: key feedback to the copied body so a prop change drops stale labels
  // without setState-in-effect (react-doctor no-adjust-state-on-prop-change).
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null)
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const copyStatus: 'idle' | 'copied' | 'failed' =
    feedback != null && feedback.body === body ? feedback.status : 'idle'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
    }
  }, [])

  // Drop any pending reset timer when the body changes; display status is already idle.
  useEffect(() => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = null
    }
  }, [body])

  const handleCopy = async (): Promise<void> => {
    if (!canCopy || disabled) {
      return
    }
    try {
      await clipboard.writeText(body)
      if (!mountedRef.current) {
        return
      }
      setFeedback({ body, status: 'copied' })
    } catch {
      // The guard first: a row unmounted before the refusal arrives has nothing to explain a buzz
      // with, and the feedback it would set is read by a component that is gone.
      if (!mountedRef.current) {
        return
      }
      // The row says so on its own control rather than in a toast; the buzz is the part a thumb
      // resting on the button it just pressed can notice without looking.
      triggerError()
      setFeedback({ body, status: 'failed' })
    }
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current)
    }
    copyResetTimerRef.current = setTimeout(() => {
      copyResetTimerRef.current = null
      if (mountedRef.current) {
        setFeedback(null)
      }
    }, 1500)
  }

  const copyDisabled = disabled || !canCopy
  const copyLabel =
    copyStatus === 'copied'
      ? 'Copied'
      : copyStatus === 'failed'
        ? "Couldn't copy"
        : canCopy
          ? `Copy ${command.label}`
          : 'Nothing to copy'
  const copyIconColor =
    copyStatus === 'copied'
      ? colors.statusGreen
      : copyStatus === 'failed'
        ? colors.danger
        : colors.textSecondary
  const [expanded, setExpanded] = useState(false)

  return (
    <View style={disabled && styles.disabled}>
      <View style={styles.row}>
        <Pressable
          style={styles.rowMainTouch}
          disabled={disabled}
          onPress={() => onLaunch(command)}
          onLongPress={() => {
            triggerMediumImpact()
            setExpanded((open) => !open)
          }}
          accessibilityRole="button"
          accessibilityLabel={`Run ${command.label}`}
          accessibilityHint="Long press for edit and delete"
        >
          {({ pressed }) => (
            <View
              style={[
                styles.rowMain,
                pressed && !disabled && styles.pressed,
                pressed ? pressTransition.pressed : pressTransition.rest
              ]}
            >
              <View style={styles.rowIcon}>
                {isAgent ? (
                  <MobileAgentIcon agentId={command.agent} size={20} />
                ) : (
                  <Play size={17} color={colors.textPrimary} fill={colors.textPrimary} />
                )}
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {command.label}
                </Text>
                <Text style={[styles.rowPreview, !isAgent && styles.mono]} numberOfLines={1}>
                  {getQuickCommandDisplayPreview(command)}
                </Text>
              </View>
            </View>
          )}
        </Pressable>
        <View style={styles.trailing}>
          <IconButton
            icon={copyStatus === 'copied' ? Check : Copy}
            variant="bare"
            iconSize={18}
            iconColor={copyIconColor}
            disabled={copyDisabled}
            onPress={() => void handleCopy()}
            accessibilityLabel={copyLabel}
          />
          <IconButton
            icon={MoreHorizontal}
            variant="bare"
            iconSize={18}
            iconColor={colors.textSecondary}
            selected={expanded}
            disabled={disabled}
            onPress={() => setExpanded((open) => !open)}
            accessibilityLabel={
              expanded ? `Hide actions for ${command.label}` : `More actions for ${command.label}`
            }
          />
        </View>
      </View>
      <Collapsible open={expanded}>
        <View style={styles.actions}>
          <Button
            label="Edit"
            icon={Pencil}
            size="compact"
            disabled={disabled}
            onPress={() => {
              setExpanded(false)
              onEdit(command)
            }}
            accessibilityLabel={`Edit ${command.label}`}
          />
          <Button
            label="Delete"
            icon={Trash2}
            size="compact"
            variant="destructive"
            disabled={disabled}
            onPress={() => {
              setExpanded(false)
              onDelete(command)
            }}
            accessibilityLabel={`Delete ${command.label}`}
          />
        </View>
      </Collapsible>
    </View>
  )
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: colors.fill },
  disabled: { opacity: motion.disabledOpacity },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowMainTouch: { flex: 1, minWidth: 0 },
  rowMain: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingLeft: LIST_ROW_PADDING,
    paddingRight: spacing.xs
  },
  rowIcon: { width: 28, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  rowPreview: { ...textStyles.subhead, color: colors.textSecondary },
  mono: { fontFamily: typography.monoFamily, fontSize: 13 },
  trailing: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xs },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.sm
  }
})
