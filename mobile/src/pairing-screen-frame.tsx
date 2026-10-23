import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronDown, type LucideIcon } from 'lucide-react-native'
import {
  colors,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  textStyles,
  typography
} from './theme/mobile-theme'
import { Collapsible } from './components/ui/Collapsible'
import { NavBar } from './components/ui/NavBar'
import { slideTransition } from './components/ui/transition-styles'
import { ConnectionLog } from './components/ConnectionLog'
import type { ConnectionLogEntry } from './transport/types'

/** Pairing screens stop growing here so the copy and buttons stay one readable column. */
const PAIRING_COLUMN_MAX_WIDTH = 400

type PairingScreenFrameProps = {
  title?: string
  onCancel: () => void
  /** The route's mount tracker; pairing attempts are disposed when it detaches. */
  rootRef?: (node: View | null) => void
  children: ReactNode
  /** Pinned under the content: the screen's primary and its plain alternative. */
  actions?: ReactNode
}

/** The one pairing layout: a bar with Cancel, a centred column, actions above the home indicator. */
export function PairingScreenFrame({
  title,
  onCancel,
  rootRef,
  children,
  actions
}: PairingScreenFrameProps) {
  const insets = useSafeAreaInsets()
  return (
    <View ref={rootRef} style={[styles.root, { paddingTop: insets.top }]}>
      <NavBar title={title} leading={<CancelAction onPress={onCancel} />} />
      <View style={[styles.body, { paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={[styles.column, styles.content]}>{children}</View>
        {actions ? <View style={[styles.column, styles.actions]}>{actions}</View> : null}
      </View>
    </View>
  )
}

function CancelAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Cancel"
      testID="pairing-cancel"
      style={({ pressed }) => [styles.cancel, pressed && styles.cancelPressed]}
    >
      <Text style={styles.cancelLabel}>Cancel</Text>
    </Pressable>
  )
}

type PairingMessageProps = {
  icon?: LucideIcon
  iconColor?: string
  loading?: boolean
  title: string
  message?: string
  testID?: string
  children?: ReactNode
}

/** The centred state: icon or spinner, a title, one sentence, then anything the state adds. */
export function PairingMessage({
  icon: Icon,
  iconColor,
  loading = false,
  title,
  message,
  testID,
  children
}: PairingMessageProps) {
  return (
    <View
      style={styles.message}
      testID={testID}
      accessibilityRole={loading ? 'progressbar' : undefined}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : Icon ? (
        <Icon size={34} color={iconColor ?? colors.textMuted} strokeWidth={1.75} />
      ) : null}
      <Text style={styles.messageTitle} accessibilityRole="header">
        {title}
      </Text>
      {message ? <Text style={styles.messageBody}>{message}</Text> : null}
      {children}
    </View>
  )
}

/** The raw failure and the pairing log, folded away; most people never need them. */
export function PairingDetails({ detail, logs }: { detail?: string; logs: ConnectionLogEntry[] }) {
  const [open, setOpen] = useState(false)
  if (!detail && logs.length === 0) {
    return null
  }
  return (
    <View style={styles.details}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide details' : 'Show details'}
        accessibilityState={{ expanded: open }}
        testID="pairing-details-toggle"
        style={({ pressed }) => [styles.detailsToggle, pressed && styles.detailsTogglePressed]}
      >
        <Text style={styles.detailsLabel}>{open ? 'Hide details' : 'Show details'}</Text>
        <View style={[open ? styles.chevronOpen : styles.chevronClosed, slideTransition]}>
          <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
        </View>
      </Pressable>
      {/* Stretched: the centred column would give the clipping frame no width. */}
      <View style={styles.detailsFrame}>
        <Collapsible open={open}>
          <View style={styles.detailsBody}>
            {detail ? (
              <Text style={styles.detailText} selectable>
                {detail}
              </Text>
            ) : null}
            <ConnectionLog entries={logs} title="Pairing log" />
          </View>
        </Collapsible>
      </View>
    </View>
  )
}

/** A pairing failure as a sentence a person can act on; the raw error goes behind Show details. */
export function pairingFailure(
  err: unknown,
  timedOut: boolean,
  timeoutMs: number
): { message: string; detail: string } {
  const raw = err instanceof Error ? err.message : String(err)
  if (timedOut) {
    return {
      message: `Your desktop didn't answer within ${timeoutMs / 1000} seconds. Check that Orca is open on your computer and both devices are online, then try again.`,
      detail: raw
    }
  }
  return {
    message:
      "Orca couldn't finish pairing with this desktop. Check that Orca is open on your computer, then try again.",
    detail: raw
  }
}

export const INVALID_PAIRING_CODE_MESSAGE =
  "This pairing code isn't valid or has expired. Show a new code on your computer and try again."

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgBase },
  body: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  column: { width: '100%', maxWidth: PAIRING_COLUMN_MAX_WIDTH, alignSelf: 'center' },
  content: { flex: 1 },
  actions: { gap: spacing.xs, paddingTop: spacing.md },
  cancel: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    justifyContent: 'center'
  },
  cancelPressed: { backgroundColor: colors.fill },
  cancelLabel: { ...textStyles.headline, fontWeight: '400', color: colors.textPrimary },
  message: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: spacing.sm
  },
  messageTitle: {
    ...textStyles.title,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 6
  },
  messageBody: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  details: { width: '100%', alignItems: 'center', marginTop: spacing.sm },
  detailsToggle: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill
  },
  detailsTogglePressed: { backgroundColor: colors.fill },
  detailsLabel: { ...textStyles.subhead, fontWeight: '500', color: colors.textSecondary },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
  chevronClosed: { transform: [{ rotate: '0deg' }] },
  detailsFrame: { alignSelf: 'stretch' },
  detailsBody: { width: '100%', gap: spacing.sm, marginTop: spacing.xs },
  detailText: {
    ...textStyles.footnote,
    fontFamily: typography.monoFamily,
    color: colors.textMuted,
    paddingHorizontal: spacing.xs
  }
})
