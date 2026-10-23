import { useState } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { colors, spacing, radii, textStyles, typography } from '../theme/mobile-theme'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { TextField } from '../components/ui/TextField'
import { pressTransition } from '../components/ui/transition-styles'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { MobileSwitch } from '../components/MobileSwitch'
import { triggerSelection } from '../platform/haptics'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import {
  getQuickCommandAgentLabel,
  getTerminalQuickCommandBodySize,
  formatKilobytes,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from '../terminal/quick-commands'
import type { QuickCommandDraft } from './quick-command-draft'
import { isQuickCommandDraftPromptTooLong, isQuickCommandDraftValid } from './quick-command-draft'

type Props = {
  draft: QuickCommandDraft
  mode: 'add' | 'edit'
  saving: boolean
  error: string | null
  // A mobile session lives in one repo, so "Project" scope means the current
  // worktree's repo — no cross-repo picker like desktop.
  repoId: string | null
  repoName: string | null
  /** An older host's agent-prompt character cap; `null` means none. */
  agentPromptMaxLength: number | null
  onChange: (patch: Partial<QuickCommandDraft>) => void
  onOpenAgentPicker: () => void
  onSave: () => void
}

const ACTION_SEGMENTS = [
  { value: 'terminal-command', label: 'Terminal command' },
  { value: 'agent-prompt', label: 'Agent prompt' }
] as const

const SCOPE_SEGMENTS = [
  { value: 'global', label: 'Global' },
  { value: 'repo', label: 'This project' }
] as const

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
  onSave
}: Props) {
  const hasRepoScope = repoId !== null
  const [advancedOpen, setAdvancedOpen] = useState(draft.scope.type === 'repo')
  const [bodyFocused, setBodyFocused] = useState(false)
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
      <TextField
        label="Name"
        value={draft.label}
        onChangeText={(label) => onChange({ label })}
        placeholder="Start dev server"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={MAX_QUICK_COMMAND_LABEL_LENGTH}
      />

      <View style={styles.field}>
        <Text style={styles.label}>Runs</Text>
        <MobileSegmentedControl
          segments={ACTION_SEGMENTS}
          selected={draft.action}
          onSelect={(action) => onChange({ action })}
          fill
        />
      </View>

      {isAgent ? (
        <View style={styles.field}>
          <Text style={styles.label}>Agent</Text>
          <Pressable
            onPress={onOpenAgentPicker}
            accessibilityRole="button"
            accessibilityLabel={
              draft.agent ? `Agent, ${getQuickCommandAgentLabel(draft.agent)}` : 'Choose agent'
            }
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.select,
                  pressed && styles.selectPressed,
                  pressed ? pressTransition.pressed : pressTransition.rest
                ]}
              >
                {draft.agent ? (
                  <View style={styles.selectValue}>
                    <MobileAgentIcon agentId={draft.agent} size={20} />
                    <Text style={styles.selectValueText} numberOfLines={1}>
                      {getQuickCommandAgentLabel(draft.agent)}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.selectPlaceholder}>Choose agent</Text>
                )}
                <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
              </View>
            )}
          </Pressable>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>{isAgent ? 'Prompt' : 'Command'}</Text>
        <TextInput
          style={[
            styles.textarea,
            !isAgent && styles.mono,
            bodyFocused && styles.textareaFocused,
            promptTooLong && styles.textareaError
          ]}
          value={isAgent ? draft.prompt : draft.command}
          onChangeText={(text) => onChange(isAgent ? { prompt: text } : { command: text })}
          onFocus={() => setBodyFocused(true)}
          onBlur={() => setBodyFocused(false)}
          placeholder={isAgent ? 'Ask the agent to investigate this workspace' : 'npm run dev'}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.accentBlue}
          accessibilityLabel={isAgent ? 'Prompt' : 'Command'}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          textAlignVertical="top"
          // Why: maxLength drops the tail of a paste silently, so prompts show a refusal instead.
          maxLength={isAgent ? undefined : MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH}
        />
        {promptTooLong ? (
          <View style={styles.footnoteBlock}>
            {/* Why static text in the alert: a live count would re-announce on every keystroke. */}
            <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">
              {promptSize.olderHostCap
                ? 'Too long for this desktop. Update Orca on the desktop to save longer prompts.'
                : 'Too long to save.'}
            </Text>
            <Text style={styles.hint}>
              {promptSize.unit === 'bytes'
                ? `${formatKilobytes(promptSize.used)} / ${formatKilobytes(promptSize.max)}`
                : `${promptSize.used.toLocaleString()} / ${promptSize.max.toLocaleString()} characters`}
            </Text>
          </View>
        ) : isAgent ? (
          <Text style={styles.hint}>Supports skills, file paths and built-in commands.</Text>
        ) : null}
      </View>

      <View style={styles.advanced}>
        <SectionHeader
          title="Advanced"
          expanded={advancedOpen}
          onToggle={() => setAdvancedOpen((open) => !open)}
        />
        <Collapsible open={advancedOpen}>
          <View style={styles.advancedBody}>
            {!isAgent ? (
              <ListGroup style={styles.group}>
                <ListRow
                  title="Press Enter"
                  subtitle="Run it straight away instead of only typing it."
                  subtitleNumberOfLines={2}
                  accessory={
                    <MobileSwitch
                      value={draft.appendEnter}
                      onValueChange={(appendEnter) => {
                        triggerSelection()
                        onChange({ appendEnter })
                      }}
                      accessibilityLabel="Press Enter after the command"
                    />
                  }
                />
              </ListGroup>
            ) : null}
            <View style={styles.field}>
              <Text style={styles.label}>Available in</Text>
              {hasRepoScope ? (
                <MobileSegmentedControl
                  segments={SCOPE_SEGMENTS}
                  selected={draft.scope.type}
                  onSelect={(scopeType) =>
                    onChange({
                      scope:
                        scopeType === 'repo' && repoId
                          ? { type: 'repo', repoId }
                          : { type: 'global' }
                    })
                  }
                  fill
                />
              ) : null}
              <Text style={styles.hint}>
                {draft.scope.type === 'repo' && repoName
                  ? `Only in ${repoName}.`
                  : 'Every workspace on this desktop.'}
              </Text>
            </View>
          </View>
        </Collapsible>
      </View>

      {error ? <Banner tone="error" message={error} /> : null}

      <View style={styles.footer}>
        <Button
          label={mode === 'edit' ? 'Save' : 'Add quick command'}
          variant="primary"
          block
          disabled={!canSave}
          onPress={onSave}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: spacing.lg, paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  field: { gap: spacing.sm },
  label: { ...textStyles.footnote, fontWeight: '500', color: colors.textSecondary, paddingLeft: 4 },
  textarea: {
    ...textStyles.body,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minHeight: 96,
    maxHeight: 200,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: radii.field,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill,
    color: colors.textPrimary
  },
  textareaFocused: { borderColor: colors.fieldBorderFocused },
  textareaError: { borderColor: colors.danger },
  mono: { fontFamily: typography.monoFamily },
  footnoteBlock: { gap: 2 },
  hint: { ...textStyles.footnote, color: colors.textMuted, paddingLeft: 4 },
  error: { ...textStyles.footnote, color: colors.danger, paddingLeft: 4 },
  select: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: 14,
    borderRadius: radii.field,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill
  },
  selectPressed: { backgroundColor: colors.fill },
  selectValue: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  selectValueText: { ...textStyles.body, color: colors.textPrimary, flexShrink: 1 },
  selectPlaceholder: { ...textStyles.body, color: colors.textMuted },
  // The section header pads for a full-width screen; inside the form it starts at the field edge.
  advanced: { marginHorizontal: -(spacing.lg + 4) + spacing.xs },
  advancedBody: {
    gap: spacing.lg,
    paddingHorizontal: spacing.lg + 4 - spacing.xs,
    paddingTop: spacing.sm
  },
  group: { marginHorizontal: 0 },
  footer: { paddingTop: spacing.xs, paddingBottom: spacing.sm }
})
