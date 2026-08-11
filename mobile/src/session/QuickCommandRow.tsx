import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy, Pencil, Play, Trash2 } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { TerminalQuickCommand } from '../../../src/shared/types'
import {
  getQuickCommandDisplayPreview,
  getTerminalQuickCommandBody,
  isAgentQuickCommand
} from '../terminal/quick-commands'

type QuickCommandRowProps = {
  command: TerminalQuickCommand
  first: boolean
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
  first,
  onLaunch,
  onEdit,
  onDelete,
  disabled
}: QuickCommandRowProps) {
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
      await Clipboard.setStringAsync(body)
      if (!mountedRef.current) {
        return
      }
      setFeedback({ body, status: 'copied' })
    } catch {
      if (!mountedRef.current) {
        return
      }
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
        ? colors.statusRed
        : colors.textSecondary

  return (
    <View style={[styles.row, !first && styles.rowBorder, disabled && styles.disabled]}>
      <Pressable
        style={({ pressed }) => [styles.rowMain, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onLaunch(command)}
        accessibilityRole="button"
        accessibilityLabel={`Run ${command.label}`}
      >
        <View style={styles.rowIcon}>
          {isAgent ? (
            <MobileAgentIcon agentId={command.agent} size={16} />
          ) : (
            <Play size={14} color={colors.textPrimary} fill={colors.textPrimary} />
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
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.rowAction,
          // Why: row already dims when `disabled`; only dim again for empty body.
          !canCopy && styles.disabled,
          pressed && !copyDisabled && styles.pressed
        ]}
        disabled={copyDisabled}
        onPress={() => void handleCopy()}
        accessibilityRole="button"
        accessibilityLabel={copyLabel}
        accessibilityState={{ disabled: copyDisabled }}
      >
        {copyStatus === 'copied' ? (
          <Check size={15} color={copyIconColor} />
        ) : (
          <Copy size={15} color={copyIconColor} />
        )}
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.rowAction, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onEdit(command)}
        accessibilityLabel={`Edit ${command.label}`}
      >
        <Pencil size={15} color={colors.textSecondary} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.rowAction, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onDelete(command)}
        accessibilityLabel={`Delete ${command.label}`}
      >
        <Trash2 size={15} color={colors.statusRed} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.45 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    minWidth: 0
  },
  rowIcon: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  rowPreview: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  mono: { fontFamily: typography.monoFamily },
  rowAction: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' }
})
