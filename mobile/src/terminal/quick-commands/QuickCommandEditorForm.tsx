import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { concentricRadius, radii, spacing } from '../../theme/mobile-theme'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { MessageBox } from '../../components/composer-input/MessageBox'
import { TextField } from '../../components/composer-input/TextField'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { getQuickCommandAgentLabel } from './quick-commands'
import { getTerminalQuickCommandBodySize } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import {
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from '../../../../src/shared/terminal/quick-commands/terminal-quick-commands'

import { type QuickCommandDraft, isQuickCommandDraftPromptTooLong } from './quick-command-draft'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { MobileSwitch } from '../../components/controls/MobileSwitch'

type Props = {
  draft: QuickCommandDraft
  error: string | null
  // A mobile session lives in one repo, so "Project" scope means the current
  // worktree's repo — no cross-repo picker like desktop.
  repoId: string | null
  repoName: string | null
  agentPromptMaxLength: number | null
  onChange: (patch: Partial<QuickCommandDraft>) => void
  onOpenAgentPicker: () => void
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange
}: {
  options: { value: T; label: string; disabled?: boolean }[]
  value: T
  onChange: (value: T) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.toggleGroup}>
      {options.map((option) => {
        const selected = value === option.value
        return (
          <Pressable
            key={option.value}
            disabled={option.disabled}
            style={({ pressed }) => [
              styles.toggleItem,
              selected && styles.toggleItemSelected,
              option.disabled && styles.toggleItemDisabled,
              pressed && !selected && styles.pressed
            ]}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: option.disabled === true }}
          >
            <Text style={[styles.toggleText, selected && styles.toggleTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// The editor's body; Cancel and Save live in the sheet's header.
export function QuickCommandEditorForm({
  draft,
  error,
  repoId,
  repoName,
  agentPromptMaxLength,
  onChange,
  onOpenAgentPicker
}: Props) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const [advancedOpen, setAdvancedOpen] = useState(draft.scope.type === 'repo')
  const isAgent = draft.action === 'agent-prompt'
  const promptTooLong = isQuickCommandDraftPromptTooLong(draft, agentPromptMaxLength)
  const promptSize = getTerminalQuickCommandBodySize(
    'agent-prompt',
    draft.prompt,
    agentPromptMaxLength
  )
  const appendEnterTitle = t('session.quickCommandEditorForm.appendEnter', 'Append Enter')

  return (
    <View style={styles.form}>
      {/* A failed save shows under the header, beside the Save the user just tapped. */}
      {error ? <SettingsNote error>{error}</SettingsNote> : null}
      <SectionHeader title={t('session.quickCommandEditorForm.label', 'Label')} first />
      <TextField
        value={draft.label}
        onChangeText={(label) => onChange({ label })}
        placeholder={t('session.quickCommandEditorForm.labelPlaceholder', 'Start dev server')}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={MAX_QUICK_COMMAND_LABEL_LENGTH}
      />

      <SectionHeader title={t('session.quickCommandEditorForm.action', 'Action')} />
      <ToggleGroup
        options={[
          {
            value: 'terminal-command',
            label: t('session.quickCommandEditorForm.terminalCommand', 'Terminal Command')
          },
          {
            value: 'agent-prompt',
            label: t('session.quickCommandEditorForm.agentPrompt', 'Agent Prompt')
          }
        ]}
        value={draft.action}
        onChange={(action) => onChange({ action })}
      />

      {isAgent ? (
        <ListGroup style={styles.agentGroup}>
          <ListRow
            title={t('session.quickCommandEditorForm.agent', 'Agent')}
            value={
              draft.agent
                ? getQuickCommandAgentLabel(draft.agent)
                : t('session.quickCommandEditorForm.chooseAgent', 'Choose agent')
            }
            valueIcon={
              draft.agent ? <MobileAgentIcon agentId={draft.agent} size={16} /> : undefined
            }
            navigates
            onPress={onOpenAgentPicker}
          />
        </ListGroup>
      ) : null}

      <SectionHeader
        title={
          isAgent
            ? t('session.quickCommandEditorForm.prompt', 'Prompt')
            : t('session.quickCommandEditorForm.commandText', 'Command Text')
        }
      />
      <MessageBox
        monospace={!isAgent}
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
        autoCapitalize="none"
        autoCorrect={false}
        // Why: maxLength drops the tail of a paste silently, so prompts show a refusal instead.
        maxLength={isAgent ? undefined : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH}
      />
      {promptTooLong ? (
        <>
          {/* Why static text in the alert: a live count would re-announce on every keystroke. */}
          <SettingsNote error>
            {promptSize.olderHostCap
              ? t(
                  'session.quickCommandEditorForm.olderHostPromptTooLong',
                  'Too long for this host. Update Orca on the host to save longer prompts.'
                )
              : t('session.quickCommandEditorForm.promptTooLong', 'Too long to save.')}
          </SettingsNote>
          <SettingsNote>
            {promptSize.unit === 'bytes'
              ? t(
                  'session.quickCommandEditorForm.promptSizeKilobytes',
                  '{{used}} KB / {{max}} KB',
                  {
                    used: Math.ceil(promptSize.used / 1024).toLocaleString(intlLocale),
                    max: Math.ceil(promptSize.max / 1024).toLocaleString(intlLocale)
                  }
                )
              : t(
                  'session.quickCommandEditorForm.promptSizeCharacters',
                  '{{used}} / {{max}} characters',
                  {
                    used: promptSize.used.toLocaleString(intlLocale),
                    max: promptSize.max.toLocaleString(intlLocale)
                  }
                )}
          </SettingsNote>
        </>
      ) : isAgent ? (
        <SettingsNote>
          {t(
            'session.quickCommandEditorForm.promptHint',
            'Supports skills, file paths, and built-in commands.'
          )}
        </SettingsNote>
      ) : null}

      <SectionHeader
        title={t('session.quickCommandEditorForm.advanced', 'Advanced')}
        expanded={advancedOpen}
        onToggle={() => setAdvancedOpen((open) => !open)}
      />
      {advancedOpen ? (
        <>
          {!isAgent ? (
            <ListGroup style={styles.advancedGroup}>
              <ListRow
                title={appendEnterTitle}
                subtitle={t(
                  'session.quickCommandEditorForm.appendEnterDescription',
                  'Submit immediately instead of only inserting text.'
                )}
                accessory={
                  <MobileSwitch
                    accessibilityLabel={appendEnterTitle}
                    value={draft.appendEnter}
                    onValueChange={(appendEnter) => onChange({ appendEnter })}
                  />
                }
              />
            </ListGroup>
          ) : null}
          <ToggleGroup
            options={[
              {
                value: 'global',
                label: t('session.quickCommandEditorForm.globalScope', 'Global')
              },
              {
                value: 'repo',
                label: t('session.quickCommandEditorForm.projectScope', 'Project'),
                disabled: repoId === null
              }
            ]}
            value={draft.scope.type}
            onChange={(scopeType) =>
              onChange({
                scope:
                  scopeType === 'repo' && repoId ? { type: 'repo', repoId } : { type: 'global' }
              })
            }
          />
          {draft.scope.type === 'repo' && repoName ? <SettingsNote>{repoName}</SettingsNote> : null}
        </>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  form: { paddingBottom: spacing.sm },
  pressed: { backgroundColor: colors.borderSubtle },
  toggleGroup: { flexDirection: 'row', gap: spacing.sm },
  toggleItem: {
    flex: 1,
    height: 40,
    borderRadius: concentricRadius(radii.control, 2),
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toggleItemSelected: { backgroundColor: colors.translucentFill, borderColor: colors.textMuted },
  toggleItemDisabled: { opacity: 0.4 },
  toggleText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  toggleTextSelected: { color: colors.textPrimary },
  advancedGroup: { marginBottom: spacing.sm },
  // The picker row follows the Action toggle the way a section follows another.
  agentGroup: { marginTop: spacing.lg }
}))
