import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
  allowAlwaysTrust?: boolean
  onRunOnce: () => void
  onAlwaysTrust: () => void
  onDontRun: () => void
  onClose: () => void
}

// Prompt before create runs untrusted repo-owned orca.yaml setup; caller retains async persistence/create.
export function SetupHookTrustDrawer({
  visible,
  prompt,
  busy,
  allowAlwaysTrust = true,
  onRunOnce,
  onAlwaysTrust,
  onDontRun,
  onClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <BottomDrawer visible={visible && prompt != null} onClose={onClose}>
      {prompt ? (
        <View>
          <View style={styles.trustHeader}>
            <Text style={styles.title}>
              {prompt.previouslyApproved
                ? t(
                    'components.setupHookTrustDrawer.scriptChangedTitle',
                    "{{repoName}}'s setup script changed",
                    { repoName: prompt.repoName }
                  )
                : t(
                    'components.setupHookTrustDrawer.runSetupTitle',
                    'Run setup from {{repoName}}?',
                    {
                      repoName: prompt.repoName
                    }
                  )}
            </Text>
            <Text style={styles.subtitle}>
              {t(
                'components.setupHookTrustDrawer.description',
                "This repository's orca.yaml runs before the workspace starts. Only run it if you trust this repository."
              )}
            </Text>
          </View>

          <View style={styles.trustScriptBox}>
            <Text style={styles.trustScriptLabel}>
              {prompt.previouslyApproved
                ? t('components.setupHookTrustDrawer.newScriptLabel', 'New setup script')
                : t('components.setupHookTrustDrawer.scriptLabel', 'Setup script')}
            </Text>
            <Text style={styles.trustScriptText}>{prompt.scriptContent}</Text>
          </View>

          <View style={styles.trustActionGroup}>
            <Pressable style={styles.trustActionRow} disabled={busy} onPress={onRunOnce}>
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.trustActionText}>
                {t('components.setupHookTrustDrawer.runHooks', 'Run hooks')}
              </Text>
            </Pressable>
            <View style={styles.trustActionSeparator} />
            {allowAlwaysTrust ? (
              <>
                <Pressable style={styles.trustActionRow} disabled={busy} onPress={onAlwaysTrust}>
                  <Check size={16} color={colors.textPrimary} />
                  <Text style={styles.trustActionText}>
                    {t('components.setupHookTrustDrawer.alwaysTrustAndRun', 'Always trust and run')}
                  </Text>
                </Pressable>
                <View style={styles.trustActionSeparator} />
              </>
            ) : null}
            <Pressable style={styles.trustActionRow} disabled={busy} onPress={onDontRun}>
              <Text style={styles.trustActionText}>
                {t('components.setupHookTrustDrawer.dontRun', "Don't run")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
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
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
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
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
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
}))
