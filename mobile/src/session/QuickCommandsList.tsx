import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { Pencil, Plus, Search, Trash2, Check, Play } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { MOBILE_AGENT_CATALOG } from '../tasks/mobile-agent-catalog'
import type { TerminalQuickCommand, TuiAgent } from '../../../src/shared/types'
import {
  getQuickCommandDisplayPreview,
  isAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../terminal/quick-commands'

export const QUICK_COMMAND_SUPPORTED_AGENTS = MOBILE_AGENT_CATALOG.filter((entry) =>
  supportsTerminalAgentQuickCommand(entry.id)
)

export const QUICK_COMMAND_SEARCH_QUERY_MAX_LENGTH = 2048

type ListProps = {
  repoCommands: TerminalQuickCommand[]
  globalCommands: TerminalQuickCommand[]
  totalCount: number
  query: string
  loading: boolean
  disabled: boolean
  canAdd: boolean
  error: string | null
  onQueryChange: (value: string) => void
  onLaunch: (command: TerminalQuickCommand) => void
  onEdit: (command: TerminalQuickCommand) => void
  onDelete: (command: TerminalQuickCommand) => void
  onAdd: () => void
}

export function QuickCommandsList({
  repoCommands,
  globalCommands,
  totalCount,
  query,
  loading,
  disabled,
  canAdd,
  error,
  onQueryChange,
  onLaunch,
  onEdit,
  onDelete,
  onAdd
}: ListProps) {
  const hasVisible = repoCommands.length + globalCommands.length > 0
  const addDisabled = disabled || !canAdd
  // Why: keep an active filter clearable if a delete or paired desktop edit
  // leaves only one command while the sheet is open.
  const showSearch = totalCount > 1 || query.length > 0
  return (
    <View style={styles.listBody}>
      {showSearch ? (
        <View style={styles.search}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search quick commands..."
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            // Why: bound pasted text before it reaches the per-keystroke JS
            // search path; useful queries are far smaller than this budget.
            maxLength={QUICK_COMMAND_SEARCH_QUERY_MAX_LENGTH}
          />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading && !hasVisible ? (
        <ActivityIndicator style={styles.loading} color={colors.textSecondary} />
      ) : null}

      {!loading && totalCount === 0 ? (
        <Text style={styles.empty}>No quick commands yet.</Text>
      ) : null}

      {!loading && totalCount > 0 && !hasVisible ? (
        <Text style={styles.empty}>No matching quick commands.</Text>
      ) : null}

      {repoCommands.length > 0 ? (
        <QuickCommandGroup
          label="This project"
          commands={repoCommands}
          onLaunch={onLaunch}
          onEdit={onEdit}
          onDelete={onDelete}
          disabled={disabled}
        />
      ) : null}

      {globalCommands.length > 0 ? (
        <QuickCommandGroup
          label="Global"
          commands={globalCommands}
          onLaunch={onLaunch}
          onEdit={onEdit}
          onDelete={onDelete}
          disabled={disabled}
        />
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.addRow,
          addDisabled && styles.disabled,
          pressed && !addDisabled && styles.pressed
        ]}
        disabled={addDisabled}
        onPress={onAdd}
        accessibilityRole="button"
      >
        <Plus size={18} color={colors.textSecondary} />
        <Text style={styles.addText}>
          {canAdd ? 'New quick command' : 'Quick command limit reached'}
        </Text>
      </Pressable>
    </View>
  )
}

function QuickCommandGroup({
  label,
  commands,
  onLaunch,
  onEdit,
  onDelete,
  disabled
}: {
  label: string
  commands: TerminalQuickCommand[]
  onLaunch: (command: TerminalQuickCommand) => void
  onEdit: (command: TerminalQuickCommand) => void
  onDelete: (command: TerminalQuickCommand) => void
  disabled: boolean
}) {
  return (
    <View>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.group}>
        {commands.map((command, index) => (
          <QuickCommandRow
            key={command.id}
            command={command}
            first={index === 0}
            onLaunch={onLaunch}
            onEdit={onEdit}
            onDelete={onDelete}
            disabled={disabled}
          />
        ))}
      </View>
    </View>
  )
}

function QuickCommandRow({
  command,
  first,
  onLaunch,
  onEdit,
  onDelete,
  disabled
}: {
  command: TerminalQuickCommand
  first: boolean
  onLaunch: (command: TerminalQuickCommand) => void
  onEdit: (command: TerminalQuickCommand) => void
  onDelete: (command: TerminalQuickCommand) => void
  disabled: boolean
}) {
  const isAgent = isAgentQuickCommand(command)
  return (
    <View style={[styles.row, !first && styles.rowBorder, disabled && styles.disabled]}>
      <Pressable
        style={({ pressed }) => [styles.rowMain, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onLaunch(command)}
        accessibilityRole="button"
        accessibilityLabel={`Run ${command.label}`}
      >
        <View style={styles.rowIcon}>
          {isAgent ? (
            <MobileAgentIcon agentId={command.agent} size={16} />
          ) : (
            <Play size={14} color={colors.textPrimary} fill={colors.textPrimary} />
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {command.label}
          </Text>
          <Text style={[styles.rowPreview, !isAgent && styles.mono]} numberOfLines={1}>
            {getQuickCommandDisplayPreview(command)}
          </Text>
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.rowAction, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onEdit(command)}
        accessibilityLabel={`Edit ${command.label}`}
      >
        <Pencil size={15} color={colors.textSecondary} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.rowAction, pressed && !disabled && styles.pressed]}
        disabled={disabled}
        onPress={() => onDelete(command)}
        accessibilityLabel={`Delete ${command.label}`}
      >
        <Trash2 size={15} color={colors.statusRed} />
      </Pressable>
    </View>
  )
}

export function QuickCommandAgentPicker({
  selected,
  onSelect
}: {
  selected: TuiAgent | null
  onSelect: (agent: TuiAgent) => void
}) {
  return (
    <View style={styles.group}>
      {QUICK_COMMAND_SUPPORTED_AGENTS.map((agent, index) => (
        <Pressable
          key={agent.id}
          style={({ pressed }) => [
            styles.row,
            index > 0 && styles.rowBorder,
            pressed && styles.pressed
          ]}
          onPress={() => onSelect(agent.id)}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === agent.id }}
        >
          <View style={styles.rowIcon}>
            <MobileAgentIcon agentId={agent.id} size={16} />
          </View>
          <Text style={styles.agentLabel}>{agent.label}</Text>
          {selected === agent.id ? <Check size={16} color={colors.textPrimary} /> : null}
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.45 },
  listBody: { gap: spacing.sm, paddingBottom: spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 14, padding: 0 },
  error: { color: colors.statusRed, fontSize: 13, paddingHorizontal: spacing.xs },
  loading: { paddingVertical: spacing.lg },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: spacing.lg
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs
  },
  group: { backgroundColor: colors.bgPanel, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    minWidth: 0
  },
  rowIcon: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  rowPreview: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  mono: { fontFamily: typography.monoFamily },
  rowAction: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  agentLabel: { flex: 1, fontSize: 14, color: colors.textPrimary },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs
  },
  addText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary }
})
