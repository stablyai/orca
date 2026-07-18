import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

export type SetupTrustPrompt = {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

type Props = {
  visible: boolean
  prompt: SetupTrustPrompt | null
  busy: boolean
  onRunOnce: () => void
  onAlwaysTrust: () => void
  onDontRun: () => void
  onClose: () => void
}

// The repo-owned orca.yaml setup-hook trust prompt, shown before a workspace
// create that would run an untrusted setup script. Extracted from NewWorktreeModal
// to keep that file focused; the async persist/create logic stays with the caller.
export function SetupHookTrustDrawer({
  visible,
  prompt,
  busy,
  onRunOnce,
  onAlwaysTrust,
  onDontRun,
  onClose
}: Props) {
  return (
    <BottomDrawer visible={visible && prompt != null} onClose={onClose}>
      {prompt ? (
        <View>
          <View style={styles.trustHeader}>
            <Text style={styles.title}>
              {prompt.previouslyApproved
                ? `${prompt.repoName}'s setup script changed`
                : `Run setup from ${prompt.repoName}?`}
            </Text>
            <Text style={styles.subtitle}>
              This repository's orca.yaml runs before the workspace starts. Only run it if you trust
              this repository.
            </Text>
          </View>

          <View style={styles.trustScriptBox}>
            <Text style={styles.trustScriptLabel}>
              {prompt.previouslyApproved ? 'New setup script' : 'Setup script'}
            </Text>
            <Text style={styles.trustScriptText}>{prompt.scriptContent}</Text>
          </View>

          <View style={styles.trustActionGroup}>
            <Pressable style={styles.trustActionRow} disabled={busy} onPress={onRunOnce}>
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.trustActionText}>Run hooks</Text>
            </Pressable>
            <View style={styles.trustActionSeparator} />
            <Pressable style={styles.trustActionRow} disabled={busy} onPress={onAlwaysTrust}>
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.trustActionText}>Always trust and run</Text>
            </Pressable>
            <View style={styles.trustActionSeparator} />
            <Pressable style={styles.trustActionRow} disabled={busy} onPress={onDontRun}>
              <Text style={styles.trustActionText}>Don't run</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  trustHeader: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  trustScriptBox: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  trustScriptLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.sm
  },
  trustScriptText: {
    fontSize: 13,
    fontFamily: typography.monoFamily,
    color: colors.textPrimary
  },
  trustActionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    overflow: 'hidden'
  },
  trustActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md
  },
  trustActionText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '500'
  },
  trustActionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
