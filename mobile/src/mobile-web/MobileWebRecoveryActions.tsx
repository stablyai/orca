import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { hybridShellStyles as styles } from './hybrid-shell-styles'

type RecoveryAction = 'retry' | 'previous' | 'clear' | 'hosts'

type MobileWebRecoveryActionsProps = {
  canUsePrevious: boolean
  align?: 'center' | 'start'
  onRetry: () => void | Promise<void>
  onUsePrevious: () => void | Promise<void>
  onClearCache: () => void | Promise<void>
  onShowHosts: () => void | Promise<void>
  onFailure: () => void
}

export function MobileWebRecoveryActions({
  canUsePrevious,
  align = 'center',
  onRetry,
  onUsePrevious,
  onClearCache,
  onShowHosts,
  onFailure
}: MobileWebRecoveryActionsProps) {
  const [busyAction, setBusyAction] = useState<RecoveryAction>()
  const [showBusy, setShowBusy] = useState(false)

  useEffect(() => {
    setShowBusy(false)
    if (!busyAction) {
      return
    }
    const timer = setTimeout(() => setShowBusy(true), 200)
    return () => clearTimeout(timer)
  }, [busyAction])

  const run = async (action: RecoveryAction, operation: () => void | Promise<void>) => {
    if (busyAction) {
      return
    }
    setBusyAction(action)
    try {
      await operation()
    } catch {
      onFailure()
    } finally {
      setBusyAction(undefined)
    }
  }

  // Retry is the only action most people need; the rest stay reachable as demoted links.
  const secondaryActions = [
    ...(canUsePrevious
      ? [
          {
            id: 'previous' as const,
            label: 'Use last version',
            testID: 'mobile-web-recovery-previous',
            operation: onUsePrevious
          }
        ]
      : []),
    {
      id: 'clear' as const,
      label: 'Reset',
      testID: 'mobile-web-recovery-reset',
      operation: onClearCache
    },
    {
      id: 'hosts' as const,
      label: 'Switch hosts',
      testID: 'mobile-web-recovery-hosts',
      operation: onShowHosts
    }
  ]
  const busy = Boolean(busyAction)

  return (
    <View
      accessibilityRole="toolbar"
      style={[styles.recoveryActions, align === 'start' && styles.recoveryActionsStart]}
    >
      <Pressable
        accessibilityLabel="Retry"
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        testID="mobile-web-recovery-retry"
        style={({ pressed }) => [
          styles.recoveryPrimaryButton,
          pressed && styles.recoveryPressed,
          busy && styles.recoveryDisabled
        ]}
        onPress={() => void run('retry', onRetry)}
      >
        {busyAction === 'retry' && showBusy ? (
          <ActivityIndicator color={colors.bgBase} size="small" />
        ) : null}
        <Text style={styles.recoveryPrimaryButtonText}>Retry</Text>
      </Pressable>
      <View style={[styles.recoveryLinkRow, align === 'start' && styles.recoveryActionsStart]}>
        {secondaryActions.map((action) => (
          <Pressable
            key={action.id}
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={8}
            testID={action.testID}
            style={({ pressed }) => [
              styles.recoveryLink,
              pressed && styles.recoveryPressed,
              busy && styles.recoveryDisabled
            ]}
            onPress={() => void run(action.id, action.operation)}
          >
            {busyAction === action.id && showBusy ? (
              <ActivityIndicator color={colors.accentBlue} size="small" />
            ) : null}
            <Text style={styles.recoveryLinkText}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
