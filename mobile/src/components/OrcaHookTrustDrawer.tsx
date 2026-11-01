import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Translate } from '../i18n/mobile-i18n'
import { BottomDrawer } from './BottomDrawer'

export type OrcaHookTrustPrompt = {
  kind: 'setup' | 'archive'
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

type Props = {
  visible: boolean
  prompt: OrcaHookTrustPrompt | null
  busy?: boolean
  allowAlwaysTrust?: boolean
  onRunOnce: () => void
  onAlwaysTrust: () => void
  onDontRun: () => void
  onClose: () => void
}

// Prompt before untrusted repo-owned orca.yaml setup or archive runs; caller retains async persistence and the action.
export function OrcaHookTrustDrawer({
  visible,
  prompt,
  busy = false,
  allowAlwaysTrust = true,
  onRunOnce,
  onAlwaysTrust,
  onDontRun,
  onClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = prompt ? hookTrustCopy(t, prompt) : null
  return (
    <BottomDrawer visible={visible && prompt != null} onClose={onClose}>
      {prompt && copy ? (
        <View>
          <View style={styles.trustHeader}>
            <Text style={styles.title}>{copy.title}</Text>
            <Text style={styles.subtitle}>{copy.description}</Text>
          </View>

          <View style={styles.trustScriptBox}>
            <Text style={styles.trustScriptLabel}>{copy.scriptLabel}</Text>
            <Text style={styles.trustScriptText}>{prompt.scriptContent}</Text>
          </View>

          <View style={styles.trustActionGroup}>
            <Pressable
              style={({ pressed }) => [
                styles.trustActionRow,
                pressed && { backgroundColor: colors.translucentFill }
              ]}
              disabled={busy}
              onPress={onRunOnce}
            >
              <Check size={16} color={colors.textPrimary} />
              <Text style={styles.trustActionText}>
                {t('components.setupHookTrustDrawer.runHooks', 'Run hooks')}
              </Text>
            </Pressable>
            <View style={styles.trustActionSeparator} />
            {allowAlwaysTrust ? (
              <>
                <Pressable
                  style={({ pressed }) => [
                    styles.trustActionRow,
                    pressed && { backgroundColor: colors.translucentFill }
                  ]}
                  disabled={busy}
                  onPress={onAlwaysTrust}
                >
                  <Check size={16} color={colors.textPrimary} />
                  <Text style={styles.trustActionText}>
                    {t('components.setupHookTrustDrawer.alwaysTrustAndRun', 'Always trust and run')}
                  </Text>
                </Pressable>
                <View style={styles.trustActionSeparator} />
              </>
            ) : null}
            <Pressable
              style={({ pressed }) => [
                styles.trustActionRow,
                pressed && { backgroundColor: colors.translucentFill }
              ]}
              disabled={busy}
              onPress={onDontRun}
            >
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

function hookTrustCopy(
  t: Translate,
  prompt: OrcaHookTrustPrompt
): { title: string; description: string; scriptLabel: string } {
  const repoName = { repoName: prompt.repoName }
  if (prompt.kind === 'archive') {
    return {
      title: prompt.previouslyApproved
        ? t(
            'components.setupHookTrustDrawer.archiveScriptChangedTitle',
            "{{repoName}}'s archive script changed",
            repoName
          )
        : t(
            'components.setupHookTrustDrawer.runArchiveTitle',
            'Run archive script from {{repoName}}?',
            repoName
          ),
      description: t(
        'components.setupHookTrustDrawer.archiveDescription',
        "This repository's orca.yaml runs before the workspace is deleted. Only run it if you trust this repository."
      ),
      scriptLabel: prompt.previouslyApproved
        ? t('components.setupHookTrustDrawer.newArchiveScriptLabel', 'New archive script')
        : t('components.setupHookTrustDrawer.archiveScriptLabel', 'Archive script')
    }
  }
  return {
    title: prompt.previouslyApproved
      ? t(
          'components.setupHookTrustDrawer.scriptChangedTitle',
          "{{repoName}}'s setup script changed",
          repoName
        )
      : t(
          'components.setupHookTrustDrawer.runSetupTitle',
          'Run setup from {{repoName}}?',
          repoName
        ),
    description: t(
      'components.setupHookTrustDrawer.description',
      "This repository's orca.yaml runs before the workspace starts. Only run it if you trust this repository."
    ),
    scriptLabel: prompt.previouslyApproved
      ? t('components.setupHookTrustDrawer.newScriptLabel', 'New setup script')
      : t('components.setupHookTrustDrawer.scriptLabel', 'Setup script')
  }
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
