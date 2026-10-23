import { View, StyleSheet } from 'react-native'
import { Plus, Search, SquareChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { MobileSearchField } from '../components/MobileSearchField'
import { Banner } from '../components/ui/Banner'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { MOBILE_AGENT_CATALOG } from '../tasks/mobile-agent-catalog'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { supportsTerminalAgentQuickCommand } from '../terminal/quick-commands'
import { QuickCommandRow } from './QuickCommandRow'

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
          <MobileSearchField
            value={query}
            // Why: bound pasted text before it reaches the per-keystroke JS
            // search path; useful queries are far smaller than this budget.
            onChangeText={(text) =>
              onQueryChange(text.slice(0, QUICK_COMMAND_SEARCH_QUERY_MAX_LENGTH))
            }
            onClear={() => onQueryChange('')}
            placeholder="Search quick commands"
          />
        </View>
      ) : null}

      {error ? (
        <View style={styles.notice}>
          <Banner tone="error" message={error} />
        </View>
      ) : null}

      {loading && !hasVisible ? <StateView loading title="Loading quick commands…" /> : null}

      {!loading && totalCount === 0 ? (
        <StateView
          icon={SquareChevronRight}
          title="No quick commands yet"
          message="Save a terminal command or an agent prompt to run it in one tap."
        />
      ) : null}

      {!loading && totalCount > 0 && !hasVisible ? (
        <StateView icon={Search} title="No matches" message="Try a different search." />
      ) : null}

      {repoCommands.length > 0 ? (
        <QuickCommandGroup
          label="This project"
          commands={repoCommands}
          onLaunch={onLaunch}
          onEdit={onEdit}
          onDelete={onDelete}
          disabled={disabled}
          first
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
          first={repoCommands.length === 0}
        />
      ) : null}

      <ListGroup style={[styles.group, styles.addGroup]}>
        <ListRow
          title={canAdd ? 'New quick command' : 'Quick command limit reached'}
          leading={<Plus size={20} color={colors.textPrimary} strokeWidth={2.2} />}
          disabled={addDisabled}
          onPress={onAdd}
        />
      </ListGroup>
    </View>
  )
}

function QuickCommandGroup({
  label,
  commands,
  onLaunch,
  onEdit,
  onDelete,
  disabled,
  first
}: {
  label: string
  commands: TerminalQuickCommand[]
  onLaunch: (command: TerminalQuickCommand) => void
  onEdit: (command: TerminalQuickCommand) => void
  onDelete: (command: TerminalQuickCommand) => void
  disabled: boolean
  first: boolean
}) {
  return (
    <View>
      <SectionHeader title={label} count={commands.length} first={first} />
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
        {commands.map((command) => (
          <QuickCommandRow
            key={command.id}
            command={command}
            onLaunch={onLaunch}
            onEdit={onEdit}
            onDelete={onDelete}
            disabled={disabled}
          />
        ))}
      </ListGroup>
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
    <ListGroup separatorInset={LIST_LEADING_INSET} style={[styles.group, styles.pickerGroup]}>
      {QUICK_COMMAND_SUPPORTED_AGENTS.map((agent) => (
        <ListRow
          key={agent.id}
          title={agent.label}
          leading={<MobileAgentIcon agentId={agent.id} size={20} />}
          selected={selected === agent.id}
          onPress={() => {
            triggerSelection()
            onSelect(agent.id)
          }}
        />
      ))}
    </ListGroup>
  )
}

const styles = StyleSheet.create({
  listBody: { paddingBottom: spacing.sm },
  // Why: the sheet already pads 12; these add 4 so rows sit 16 from the sheet edge.
  search: { paddingHorizontal: spacing.xs, paddingBottom: spacing.xs },
  notice: { marginHorizontal: -spacing.md, paddingVertical: spacing.xs },
  group: { marginHorizontal: spacing.xs },
  addGroup: { marginTop: spacing.lg },
  pickerGroup: { marginTop: spacing.xs, marginBottom: spacing.sm }
})
