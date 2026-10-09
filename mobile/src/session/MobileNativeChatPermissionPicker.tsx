import { useState } from 'react'
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-chat-permission-mode'
import { ChoiceRow, Pill } from './MobileNativeChatSessionOptionRows'

/** The chat's permission pill: present only where the host offers a picker for this chat. */
export type MobileNativeChatPermissionPickerState = {
  provider?: string | null
  current: AgentChatPermissionMode
  supported: readonly AgentChatPermissionMode[]
  /** A pick is in flight. */
  pending: boolean
  setMode: (mode: AgentChatPermissionMode) => Promise<boolean>
}

const MODE_COPY: Record<AgentChatPermissionMode, { label: string; description: string }> = {
  ask: {
    label: 'Ask for approval',
    description: "Asks before edits and commands your settings don't allow"
  },
  'accept-edits': {
    label: 'Accept edits',
    description: 'Approves file edits and file commands; asks for the rest'
  },
  auto: {
    label: 'Approve for me',
    description: 'Reviews approval requests for you'
  },
  bypass: {
    label: 'Full access',
    description: 'Skips approval prompts; your Claude rules and sandbox still apply'
  }
}

function modeDescription(mode: AgentChatPermissionMode, provider?: string | null): string {
  if (mode === 'ask' && provider === 'codex') {
    return 'Works inside the workspace sandbox; asks before going beyond it'
  }
  if (mode === 'ask' && provider !== 'claude') {
    return 'Claude asks unless your settings allow it; Codex asks beyond the workspace sandbox'
  }
  if (mode === 'bypass' && provider === 'codex') {
    return 'Never asks; no sandbox'
  }
  if (mode === 'bypass' && provider !== 'claude') {
    return 'Skips approval prompts; Codex also runs without its sandbox'
  }
  return MODE_COPY[mode].description
}

/** Full access reads in the warning colour wherever it is shown. */
function modeColor(mode: AgentChatPermissionMode): string | undefined {
  return mode === 'bypass' ? colors.statusAmber : undefined
}

export function mobileNativeChatPermissionModeLabel(mode: AgentChatPermissionMode): string {
  return MODE_COPY[mode].label
}

/** Permission pill beside the options pill, opening its own drawer. */
export function MobileNativeChatPermissionPicker({
  picker,
  disabled
}: {
  picker: MobileNativeChatPermissionPickerState
  /** A composer send owns the input until it settles. */
  disabled: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = MODE_COPY[picker.current].label
  const close = (): void => setOpen(false)
  const choose = (mode: AgentChatPermissionMode): void => {
    void picker.setMode(mode).then((applied) => {
      if (applied) {
        close()
      }
    })
  }
  const pillColor = modeColor(picker.current)
  return (
    <View>
      <Pill
        label={label}
        accessibleName={`Permissions, ${label}`}
        disabled={disabled || picker.pending}
        onPress={() => {
          Keyboard.dismiss()
          setOpen(true)
        }}
        {...(pillColor ? { labelColor: pillColor } : {})}
      />
      <BottomDrawer visible={open} onClose={close}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Pressable
              accessibilityLabel="Close picker"
              accessibilityRole="button"
              style={({ pressed }) => [styles.sheetNav, pressed && styles.pressed]}
              onPress={close}
              hitSlop={8}
            >
              <X size={18} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.sheetTitle}>Permissions</Text>
            <View style={styles.sheetHeaderSide}>
              {picker.pending ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : null}
            </View>
          </View>
          <View style={styles.choiceGroup}>
            {picker.supported.map((mode, index) => {
              const color = modeColor(mode)
              return (
                <ChoiceRow
                  key={mode}
                  label={MODE_COPY[mode].label}
                  description={modeDescription(mode, picker.provider)}
                  selected={mode === picker.current}
                  disabled={disabled || picker.pending}
                  grouped
                  divided={index < picker.supported.length - 1}
                  onPress={() => choose(mode)}
                  {...(color ? { labelColor: color } : {})}
                />
              )
            })}
          </View>
        </View>
      </BottomDrawer>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: {
    paddingBottom: spacing.xs
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.lg
  },
  sheetTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    textAlign: 'center'
  },
  sheetNav: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  sheetHeaderSide: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  choiceGroup: {
    overflow: 'hidden',
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
