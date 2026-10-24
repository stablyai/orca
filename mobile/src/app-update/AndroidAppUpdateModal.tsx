import * as Linking from 'expo-linking'
import { ArrowDownToLine, Check, ShieldCheck } from 'lucide-react-native'
import { useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { AndroidUpdateState } from './android-update-controller'
import { androidUpdateController } from './android-update-runtime'

const noopSubscribe = () => () => {}
const emptySnapshot = () => null
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)

function AndroidAppUpdateContent({
  state,
  onDownload,
  onInstall,
  onCancel,
  onHide,
  onRelease
}: {
  state: AndroidUpdateState
  onDownload: () => void
  onInstall: () => void
  onCancel: () => void
  onHide: () => void
  onRelease: () => void
}) {
  const busy = ['loading', 'downloading', 'verifying', 'installing'].includes(state.phase)
  const installing = state.phase === 'installing'
  const ready = state.phase === 'ready'
  const permission = state.phase === 'permission'
  const title = ready
    ? 'Ready to install'
    : permission
      ? 'Allow updates from Orca'
      : `Update to Orca ${state.version}`
  const detail = ready
    ? 'The APK matches this release and your installed app. Android will ask you to confirm the update.'
    : permission
      ? 'Enable “Allow from this source” in Android Settings. Installation continues when you return.'
      : 'Download the update here, then confirm with Android. Your paired hosts and settings stay in place.'
  const stage = installing
    ? 'Opening Android installer…'
    : state.phase === 'loading'
      ? 'Getting release details…'
      : state.phase === 'verifying'
        ? 'Verifying APK…'
        : 'Downloading update…'
  const percent =
    state.total > 0 ? Math.min(100, Math.floor((state.downloaded * 100) / state.total)) : 0
  return (
    <ScrollView contentContainerStyle={styles.content} bounces={false}>
      <View style={styles.icon}>
        {ready ? (
          <ShieldCheck size={28} color={colors.textPrimary} />
        ) : (
          <ArrowDownToLine size={28} color={colors.textPrimary} />
        )}
      </View>
      <Text style={styles.eyebrow}>ORCA FOR ANDROID</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.detail}>{detail}</Text>
      <View style={styles.summary}>
        <Text style={styles.label}>New version</Text>
        <Text style={styles.value}>{state.version}</Text>
      </View>
      {busy ? (
        <View accessibilityLiveRegion="polite" style={styles.progressArea}>
          <View style={styles.progressLabel}>
            <ActivityIndicator size="small" color={colors.textPrimary} />
            <Text style={styles.stage}>{stage}</Text>
            {state.phase === 'downloading' && <Text style={styles.value}>{percent}%</Text>}
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={stage}
            accessibilityValue={{ min: 0, max: 100, now: percent }}
            style={styles.track}
          >
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
          <Text style={styles.caption}>
            {state.total > 0
              ? `${mb(state.downloaded)} of ${mb(state.total)} MB`
              : 'Connecting to GitHub'}
          </Text>
        </View>
      ) : ready ? (
        <View style={styles.verified}>
          <Check size={16} color={colors.textPrimary} />
          <Text style={styles.caption}>Checksum and signing certificate verified</Text>
        </View>
      ) : null}
      {state.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      )}
      {!busy && (
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          onPress={ready || permission ? onInstall : onDownload}
        >
          <Text style={styles.primaryText}>
            {ready
              ? 'Install update'
              : permission
                ? 'Open Android Settings'
                : state.phase === 'error'
                  ? 'Try again'
                  : 'Download update'}
          </Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        onPress={onHide}
      >
        <Text style={styles.secondaryText}>{busy ? 'Keep using Orca' : 'Not now'}</Text>
      </Pressable>
      {busy && !installing && (
        <Pressable accessibilityRole="button" style={styles.link} onPress={onCancel}>
          <Text style={styles.caption}>Cancel download</Text>
        </Pressable>
      )}
      {!busy && (
        <Pressable accessibilityRole="link" style={styles.link} onPress={onRelease}>
          <Text style={styles.caption}>View release on GitHub</Text>
        </Pressable>
      )}
      <Text style={styles.footnote}>Nothing installs without your confirmation.</Text>
    </ScrollView>
  )
}

export function AndroidAppUpdateModal() {
  const controller = androidUpdateController
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? emptySnapshot
  )
  if (!controller || !state) {
    return null
  }
  return (
    <Modal
      visible={state.visible}
      transparent
      animationType="fade"
      onRequestClose={controller.hide}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <AndroidAppUpdateContent
            state={state}
            onDownload={() => {
              void controller.download()
            }}
            onInstall={() => {
              void controller.install()
            }}
            onCancel={controller.cancel}
            onHide={controller.hide}
            onRelease={() => {
              void Linking.openURL(state.releaseUrl).catch(() => {})
            }}
          />
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '90%',
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  content: { padding: spacing.xl },
  icon: {
    width: 56,
    height: 56,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl
  },
  eyebrow: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 1,
    marginBottom: spacing.sm
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.md
  },
  detail: {
    fontSize: typography.bodySize,
    lineHeight: 21,
    color: colors.textSecondary,
    marginBottom: spacing.xl
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xl
  },
  label: { fontSize: typography.bodySize, color: colors.textSecondary },
  value: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  },
  progressArea: { gap: spacing.md, marginBottom: spacing.lg },
  progressLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stage: { flex: 1, fontSize: typography.bodySize, color: colors.textPrimary },
  track: {
    height: 4,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.row,
    overflow: 'hidden'
  },
  fill: { height: '100%', backgroundColor: colors.textPrimary },
  caption: { fontSize: typography.metaSize, color: colors.textSecondary, lineHeight: 18 },
  verified: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xl
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginBottom: spacing.lg
  },
  primary: {
    backgroundColor: colors.surfaceBright,
    borderRadius: radii.button,
    alignItems: 'center',
    padding: spacing.md,
    minHeight: 48,
    justifyContent: 'center'
  },
  primaryText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  secondary: { alignItems: 'center', padding: spacing.md, minHeight: 48, justifyContent: 'center' },
  secondaryText: { color: colors.textPrimary, fontSize: typography.bodySize },
  link: { alignItems: 'center', padding: spacing.sm, minHeight: 44, justifyContent: 'center' },
  footnote: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: spacing.md
  },
  pressed: { opacity: 0.7 }
})
