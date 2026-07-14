import { useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Edit3, PowerOff, RefreshCw } from 'lucide-react-native'

import { BottomDrawer } from './BottomDrawer'
import { ActionSheetContent, type ActionSheetAction } from './ActionSheetModal'
import type { ConnectionState, HostProfile } from '../transport/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  host: HostProfile | null
  subtitle?: string
  state: ConnectionState
  hasEverConnected: boolean
  onReconnect: (hostId: string) => void
  onDisconnect: (hostId: string) => void
  onRename: (hostId: string, name: string) => Promise<boolean>
  onRemove: (hostId: string) => Promise<boolean>
  onClose: () => void
}

type HostActionView = 'actions' | 'rename' | 'confirmRemove'

// Why: the action list and its rename / remove-confirm steps share ONE BottomDrawer and
// swap content in place. Giving each its own BottomDrawer stacked two native <Modal>s
// during the transition, which deadlocks the iOS modal stack and froze the app on remove
// (issue #8555). Mirrors the host-detail worktree action sheet's inline-confirm pattern.
export function HostActionsSheet({
  host,
  subtitle,
  state,
  hasEverConnected,
  onReconnect,
  onDisconnect,
  onRename,
  onRemove,
  onClose
}: Props) {
  const [view, setView] = useState<HostActionView>('actions')
  const [renameValue, setRenameValue] = useState('')
  // Why: guard the async rename/remove so a rapid double-tap can't fire the
  // mutation twice (the second call races an already-removed host).
  const [submitting, setSubmitting] = useState(false)
  // Why: keep rendering the last host while the drawer animates closed (the `host`
  // prop drops to null the instant the flow closes).
  const [displayHost, setDisplayHost] = useState<HostProfile | null>(null)
  const [prevHostId, setPrevHostId] = useState<string | null>(null)

  const hostId = host?.id ?? null
  // Why: reset to the action list and seed the rename field each time a new host opens,
  // without disturbing the view while the drawer is animating away.
  if (hostId !== prevHostId) {
    setPrevHostId(hostId)
    if (host) {
      setDisplayHost(host)
      setView('actions')
      setRenameValue(host.name)
      setSubmitting(false)
    }
  }

  const isLive =
    state === 'connected' ||
    state === 'connecting' ||
    state === 'handshaking' ||
    state === 'reconnecting'

  function buildActions(target: HostProfile): ActionSheetAction[] {
    const items: ActionSheetAction[] = []
    items.push({
      // Why: "Reconnect" implies a prior connection; before the first successful connect
      // this session the action is really a fresh Connect, so match the verb.
      label: hasEverConnected && isLive ? 'Reconnect' : 'Connect',
      icon: RefreshCw,
      onPress: () => onReconnect(target.id)
    })
    if (isLive) {
      items.push({
        label: 'Disconnect',
        icon: PowerOff,
        onPress: () => onDisconnect(target.id)
      })
    }
    items.push({
      label: 'Rename',
      icon: Edit3,
      skipAutoClose: true,
      onPress: () => setView('rename')
    })
    items.push({
      label: 'Remove',
      destructive: true,
      skipAutoClose: true,
      onPress: () => setView('confirmRemove')
    })
    return items
  }

  async function submitRename(target: HostProfile): Promise<void> {
    const trimmed = renameValue.trim()
    if (!trimmed || submitting) {
      return
    }
    setSubmitting(true)
    const renamed = await onRename(target.id, trimmed)
    setSubmitting(false)
    if (renamed) {
      onClose()
    } else {
      // Why: keep the rename step up so the user can retry rather than closing as
      // if it succeeded.
      Alert.alert('Could not rename host', 'Please try again.')
    }
  }

  async function removeHost(target: HostProfile): Promise<void> {
    if (submitting) {
      return
    }
    setSubmitting(true)
    const removed = await onRemove(target.id)
    setSubmitting(false)
    if (removed) {
      onClose()
    } else {
      // Why: keep the confirm step up so the user can retry rather than silently
      // leaving the host listed.
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }

  const canSaveRename = renameValue.trim().length > 0 && !submitting

  return (
    <BottomDrawer visible={host != null} onClose={onClose}>
      {displayHost == null ? null : view === 'rename' ? (
        <View>
          <View style={styles.header}>
            <Text style={styles.title}>Rename Host</Text>
            <Text style={styles.message}>Enter a new name for this host.</Text>
          </View>
          <TextInput
            style={styles.input}
            value={renameValue}
            onChangeText={setRenameValue}
            placeholder="Host name"
            placeholderTextColor={colors.textMuted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void submitRename(displayHost)}
            selectionColor={colors.accentBlue}
          />
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
              onPress={onClose}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
                !canSaveRename && styles.primaryButtonDisabled
              ]}
              disabled={!canSaveRename}
              onPress={() => void submitRename(displayHost)}
            >
              <Text style={styles.primaryText}>Save</Text>
            </Pressable>
          </View>
        </View>
      ) : view === 'confirmRemove' ? (
        <View>
          <View style={styles.header}>
            <Text style={styles.title}>Remove Host</Text>
            <Text style={styles.message}>
              Remove &quot;{displayHost.name}&quot;? You can re-pair later.
            </Text>
          </View>
          <View style={styles.buttons}>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.cancelButton,
                pressed && styles.pressed
              ]}
              onPress={onClose}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.destructiveButton,
                pressed && styles.pressed,
                submitting && styles.buttonDisabled
              ]}
              disabled={submitting}
              onPress={() => void removeHost(displayHost)}
            >
              <Text style={styles.destructiveText}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ActionSheetContent
          title={displayHost.name}
          message={subtitle}
          actions={buildActions(displayHost)}
          onClose={onClose}
        />
      )}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  input: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  textButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  primaryButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  primaryButtonDisabled: {
    opacity: 0.4
  },
  primaryText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  button: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  buttonDisabled: {
    opacity: 0.4
  },
  cancelButton: {
    backgroundColor: colors.bgPanel
  },
  destructiveButton: {
    backgroundColor: colors.statusRed
  },
  pressed: {
    opacity: 0.7
  },
  cancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  destructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
})
