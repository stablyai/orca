import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'

export type OrcaHookTrustPrompt = {
  kind: 'setup' | 'archive'
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
  /** Same-id repos on several hosts: approvals stay per version and Always trust can't cover them. */
  versionOnly: boolean
  /** The workspace exists but its create skipped this branch's setup, which differs from what was approved. */
  review?: 'created-branch'
}

type Props = {
  visible: boolean
  prompt: OrcaHookTrustPrompt | null
  busy?: boolean
  allowAlwaysTrust?: boolean
  // Automations run unattended, so a one-time approval can't cover them.
  allowRunOnce?: boolean
  zIndex?: number
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
  allowRunOnce = true,
  zIndex,
  onRunOnce,
  onAlwaysTrust,
  onDontRun,
  onClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = prompt ? hookTrustCopy(t, prompt) : null
  return (
    <BottomDrawer visible={visible && prompt != null} onClose={onClose} zIndex={zIndex}>
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

          {allowAlwaysTrust && !prompt.versionOnly ? (
            <Text style={styles.trustScope}>
              {t(
                'components.setupHookTrustDrawer.alwaysTrustScope',
                'Always trust runs future orca.yaml changes in {{repoName}} without asking.',
                { repoName: prompt.repoName }
              )}
            </Text>
          ) : null}

          <View style={styles.trustActionGroup}>
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
                  <Text style={[styles.trustActionText, styles.trustPrimaryActionText]}>
                    {t('components.setupHookTrustDrawer.alwaysTrust', 'Always trust')}
                  </Text>
                </Pressable>
                <View style={styles.trustActionSeparator} />
              </>
            ) : null}
            {allowRunOnce || prompt.versionOnly || !allowAlwaysTrust ? (
              <>
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
                    {prompt.versionOnly || !allowAlwaysTrust
                      ? t('components.setupHookTrustDrawer.runHooks', 'Run hooks')
                      : t('components.setupHookTrustDrawer.runOnce', 'Run once')}
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
  const changed = prompt.versionOnly && prompt.previouslyApproved
  if (prompt.review === 'created-branch') {
    return {
      title: t(
        'components.setupHookTrustDrawer.branchDiffersTitle',
        "This workspace's branch has different setup commands"
      ),
      description: t(
        'components.setupHookTrustDrawer.branchDiffersDescription',
        "The workspace was created, but its setup didn't run: its branch's orca.yaml differs from what you approved. Run it in this workspace only if you trust this repository."
      ),
      scriptLabel: t('components.setupHookTrustDrawer.branchSetupLabel', "Branch's setup script")
    }
  }
  if (prompt.kind === 'archive') {
    return {
      title: changed
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
      scriptLabel: changed
        ? t('components.setupHookTrustDrawer.newArchiveScriptLabel', 'New archive script')
        : t('components.setupHookTrustDrawer.archiveScriptLabel', 'Archive script')
    }
  }
  return {
    title: changed
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
    scriptLabel: changed
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
  trustScope: {
    fontSize: 13,
    color: colors.textMuted,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
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
  trustPrimaryActionText: {
    fontWeight: '600'
  },
  trustActionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
}))
