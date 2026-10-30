import { useState } from 'react'
import { View, Text, Pressable, TextInput, Switch } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  getQuickCommandAgentLabel,
  getTerminalQuickCommandBodySize,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from '../terminal/quick-commands'
import type { QuickCommandDraft } from './quick-command-draft'
import { isQuickCommandDraftPromptTooLong, isQuickCommandDraftValid } from './quick-command-draft'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'

type Props = {
  draft: QuickCommandDraft
  mode: 'add' | 'edit'
  saving: boolean
  error: string | null
  // A mobile session lives in one repo, so "Project" scope means the current
  // worktree's repo — no cross-repo picker like desktop.
  repoId: string | null
  repoName: string | null
  agentPromptMaxLength: number | null
  onChange: (patch: Partial<QuickCommandDraft>) => void
  onOpenAgentPicker: () => void
  onCancel: () => void
  onSave: () => void
}

function ActionToggle({
  value,
  onChange
}: {
  value: QuickCommandDraft['action']
  onChange: (action: QuickCommandDraft['action']) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.toggleGroup}>
      {(['terminal-command', 'agent-prompt'] as const).map((action) => {
        const selected = value === action
        return (
          <Pressable
            key={action}
            style={({ pressed }) => [
              styles.toggleItem,
              selected && styles.toggleItemSelected,
              pressed && !selected && styles.pressed
            ]}
            onPress={() => onChange(action)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.toggleText, selected && styles.toggleTextSelected]}>
              {action === 'terminal-command'
                ? t('session.quickCommandEditorForm.terminalCommand', 'Terminal Command')
                : t('session.quickCommandEditorForm.agentPrompt', 'Agent Prompt')}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function QuickCommandEditorForm({
  draft,
  mode,
  saving,
  error,
  repoId,
  repoName,
  agentPromptMaxLength,
  onChange,
  onOpenAgentPicker,
  onCancel,
  onSave
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const hasRepoScope = repoId !== null
  const [advancedOpen, setAdvancedOpen] = useState(draft.scope.type === 'repo')
  const isAgent = draft.action === 'agent-prompt'
  const canSave = isQuickCommandDraftValid(draft, agentPromptMaxLength) && !saving
  const promptTooLong = isQuickCommandDraftPromptTooLong(draft, agentPromptMaxLength)
  const promptSize = getTerminalQuickCommandBodySize(
    'agent-prompt',
    draft.prompt,
    agentPromptMaxLength
  )

  return (
    <View style={styles.form}>
      <View style={styles.field}>
        <Text style={styles.label}>{t('session.quickCommandEditorForm.label', 'Label')}</Text>
        <TextInput
          style={styles.input}
          value={draft.label}
          onChangeText={(label) => onChange({ label })}
          placeholder={t('session.quickCommandEditorForm.labelPlaceholder', 'Start dev server')}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_QUICK_COMMAND_LABEL_LENGTH}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t('session.quickCommandEditorForm.action', 'Action')}</Text>
        <ActionToggle value={draft.action} onChange={(action) => onChange({ action })} />
      </View>

      {isAgent ? (
        <View style={styles.field}>
          <Text style={styles.label}>{t('session.quickCommandEditorForm.agent', 'Agent')}</Text>
          <Pressable
            style={({ pressed }) => [styles.select, pressed && styles.pressed]}
            onPress={onOpenAgentPicker}
            accessibilityRole="button"
          >
            {draft.agent ? (
              <View style={styles.selectValue}>
                <MobileAgentIcon agentId={draft.agent} size={16} />
                <Text style={styles.selectValueText}>{getQuickCommandAgentLabel(draft.agent)}</Text>
              </View>
            ) : (
              <Text style={styles.selectPlaceholder}>
                {t('session.quickCommandEditorForm.chooseAgent', 'Choose agent')}
              </Text>
            )}
            <ChevronDown size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>
          {isAgent
            ? t('session.quickCommandEditorForm.prompt', 'Prompt')
            : t('session.quickCommandEditorForm.commandText', 'Command Text')}
        </Text>
        <TextInput
          style={[styles.input, styles.textarea, !isAgent && styles.mono]}
          value={isAgent ? draft.prompt : draft.command}
          onChangeText={(text) => onChange(isAgent ? { prompt: text } : { command: text })}
          placeholder={
            isAgent
              ? t(
                  'session.quickCommandEditorForm.promptPlaceholder',
                  'Ask the agent to investigate this workspace'
                )
              : 'npm run dev'
          }
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          // Why: maxLength drops the tail of a paste silently, so prompts show a refusal instead.
          maxLength={isAgent ? undefined : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH}
        />
        {promptTooLong ? (
          <View>
            {/* Why static text in the alert: a live count would re-announce on every keystroke. */}
            <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
              {promptSize.olderHostCap
                ? t(
                    'session.quickCommandEditorForm.olderHostPromptTooLong',
                    'Too long for this host. Update Orca on the host to save longer prompts.'
                  )
                : t('session.quickCommandEditorForm.promptTooLong', 'Too long to save.')}
            </Text>
            <Text style={styles.hint}>
              {promptSize.unit === 'bytes'
                ? t(
                    'session.quickCommandEditorForm.promptSizeKilobytes',
                    '{{used}} KB / {{max}} KB',
                    {
                      used: Math.ceil(promptSize.used / 1024).toLocaleString(getUiIntlLocale()),
                      max: Math.ceil(promptSize.max / 1024).toLocaleString(getUiIntlLocale())
                    }
                  )
                : t(
                    'session.quickCommandEditorForm.promptSizeCharacters',
                    '{{used}} / {{max}} characters',
                    {
                      used: promptSize.used.toLocaleString(getUiIntlLocale()),
                      max: promptSize.max.toLocaleString(getUiIntlLocale())
                    }
                  )}
            </Text>
          </View>
        ) : isAgent ? (
          <Text style={styles.hint}>
            {t(
              'session.quickCommandEditorForm.promptHint',
              'Supports skills, file paths, and built-in commands.'
            )}
          </Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Pressable
          style={({ pressed }) => [styles.advancedToggle, pressed && styles.pressed]}
          onPress={() => setAdvancedOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: advancedOpen }}
        >
          {advancedOpen ? (
            <ChevronDown size={16} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={16} color={colors.textSecondary} />
          )}
          <Text style={styles.advancedText}>
            {t('session.quickCommandEditorForm.advanced', 'Advanced')}
          </Text>
        </Pressable>

        {advancedOpen ? (
          <View style={styles.advancedBody}>
            {!isAgent ? (
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={styles.switchTitle}>
                    {t('session.quickCommandEditorForm.appendEnter', 'Append Enter')}
                  </Text>
                  <Text style={styles.switchDesc}>
                    {t(
                      'session.quickCommandEditorForm.appendEnterDescription',
                      'Submit immediately instead of only inserting text.'
                    )}
                  </Text>
                </View>
                <Switch
                  value={draft.appendEnter}
                  onValueChange={(appendEnter) => onChange({ appendEnter })}
                  trackColor={{ false: colors.bgRaised, true: colors.accentBlue }}
                  thumbColor={colors.surfaceBright}
                />
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.label}>{t('session.quickCommandEditorForm.scope', 'Scope')}</Text>
              <View style={styles.toggleGroup}>
                {(['global', 'repo'] as const).map((scopeType) => {
                  const selected = draft.scope.type === scopeType
                  const disabled = scopeType === 'repo' && !hasRepoScope
                  return (
                    <Pressable
                      key={scopeType}
                      disabled={disabled}
                      style={({ pressed }) => [
                        styles.toggleItem,
                        selected && styles.toggleItemSelected,
                        disabled && styles.toggleItemDisabled,
                        pressed && !selected && !disabled && styles.pressed
                      ]}
                      onPress={() =>
                        onChange({
                          scope:
                            scopeType === 'repo' && repoId
                              ? { type: 'repo', repoId }
                              : { type: 'global' }
                        })
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled }}
                    >
                      <Text style={[styles.toggleText, selected && styles.toggleTextSelected]}>
                        {scopeType === 'global'
                          ? t('session.quickCommandEditorForm.globalScope', 'Global')
                          : t('session.quickCommandEditorForm.projectScope', 'Project')}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
              {draft.scope.type === 'repo' && repoName ? (
                <Text style={styles.scopeRepoName}>{repoName}</Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [styles.button, styles.cancelButton, pressed && styles.pressed]}
          onPress={onCancel}
          accessibilityRole="button"
        >
          <Text style={styles.cancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.saveButton, !canSave && styles.saveButtonDisabled]}
          disabled={!canSave}
          onPress={onSave}
          accessibilityRole="button"
        >
          <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>
            {mode === 'edit'
              ? t('common.save', 'Save')
              : t('session.quickCommandEditorForm.addQuickCommand', 'Add Quick Command')}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  form: { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  field: { gap: spacing.sm },
  label: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  input: {
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: TEXT_INPUT_FONT_SIZE,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  textarea: { minHeight: 92, textAlignVertical: 'top' },
  mono: { fontFamily: typography.monoFamily },
  hint: { fontSize: 12, color: colors.textMuted },
  error: { fontSize: 13, color: colors.statusRed, marginTop: spacing.xs },
  pressed: { backgroundColor: colors.bgRaised },
  toggleGroup: { flexDirection: 'row', gap: spacing.sm },
  toggleItem: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toggleItemSelected: { backgroundColor: colors.bgRaised, borderColor: colors.textMuted },
  toggleItemDisabled: { opacity: 0.4 },
  toggleText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  toggleTextSelected: { color: colors.textPrimary },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  selectValue: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selectValueText: { fontSize: 14, color: colors.textPrimary },
  selectPlaceholder: { fontSize: 14, color: colors.textMuted },
  scopeRepoName: {
    fontSize: 13,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    paddingHorizontal: spacing.xs
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs
  },
  advancedText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  advancedBody: { gap: spacing.md, paddingTop: spacing.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchText: { flex: 1 },
  switchTitle: { fontSize: 14, color: colors.textPrimary },
  switchDesc: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  footer: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  button: { flex: 1, borderRadius: 8, paddingVertical: spacing.md, alignItems: 'center' },
  cancelButton: { borderWidth: 1, borderColor: colors.borderSubtle },
  cancelText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  saveButton: { backgroundColor: colors.textPrimary },
  saveButtonDisabled: { backgroundColor: colors.bgRaised },
  saveText: { fontSize: 14, fontWeight: '700', color: colors.bgBase },
  saveTextDisabled: { color: colors.textMuted }
}))
