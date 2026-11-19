import { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { FileText, Globe, SquareTerminal, UserRound } from 'lucide-react-native'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import {
  ActionSheetContent,
  type ActionSheetAction
} from '../../components/sheets/ActionSheetModal'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { MobileAgentIcon } from '../../components/icons/MobileAgentIcon'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileNewTabAgentOption } from '../agent-launch/mobile-new-tab-agent-options'
import type { NewTabAgentSurfaceChoice } from '../agent-launch/use-mobile-new-tab-agent-options'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import {
  WINDOWS_GIT_BASH_SHELL,
  type BuiltInWindowsTerminalShell
} from '../../../../src/shared/shell/launch/windows-terminal-shell'

const AGENT_GRID_COLUMNS = 3

type Props = {
  visible: boolean
  workspaceName: string
  agentOptions: readonly MobileNewTabAgentOption[]
  /** Chat or CLI for the agents below; null where the host can't take a pick. */
  surfaceChoice: NewTabAgentSurfaceChoice | null
  /** Loading, none, other-server or error; shown instead of the agent grid. */
  agentStatusRow: ActionSheetAction | null
  /** Rows that lead the agents, such as a bot's own new chat. */
  leadingAgentActions: ActionSheetAction[]
  canCreateBrowser: boolean
  /** The profile a new browser tab opens in; null hides the row (one profile, or an older host). */
  browserProfileLabel: string | null
  canCreateMarkdownNote: boolean
  onClose: () => void
  onCreateAgent: (agent: TuiAgent, nativeChatDefault: boolean | undefined) => void
  /** Desktop's Windows shell entries the host would start, its default first; empty keeps one Terminal row. */
  terminalShells: readonly BuiltInWindowsTerminalShell[]
  onCreateTerminal: (shell?: BuiltInWindowsTerminalShell) => void
  /** Runs after the sheet has gone, so it may open another modal. */
  onCreateBrowser: () => void
  /** Runs after the sheet has gone, so it may open the picker. */
  onChooseBrowserProfile: () => void
  onCreateMarkdownNote: () => void
}

// Desktop's names for its Windows shell menu entries.
function windowsShellLabel(
  shell: BuiltInWindowsTerminalShell,
  t: ReturnType<typeof useMobileTranslation>
): string {
  switch (shell) {
    case 'powershell.exe':
      return t('session.sheets.shellPowerShell', 'PowerShell')
    case 'cmd.exe':
      return t('session.sheets.shellCmd', 'CMD Prompt')
    case WINDOWS_GIT_BASH_SHELL:
      return t('session.sheets.shellGitBash', 'Git Bash')
    case 'wsl.exe':
      return t('session.sheets.shellWsl', 'WSL')
  }
}

export function MobileNewTabSheet({
  visible,
  workspaceName,
  agentOptions,
  surfaceChoice,
  agentStatusRow,
  leadingAgentActions,
  canCreateBrowser,
  browserProfileLabel,
  canCreateMarkdownNote,
  onClose,
  onCreateAgent,
  terminalShells,
  onCreateTerminal,
  onCreateBrowser,
  onChooseBrowserProfile,
  onCreateMarkdownNote
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Wait for the iOS sheet window to unmount before presenting another native modal.
  const afterCloseRef = useRef<(() => void) | null>(null)
  const closeThen = (action: () => void) => {
    afterCloseRef.current = action
    onClose()
  }
  const closeAndRun = (action: () => void) => {
    onClose()
    action()
  }
  const showAgentGrid = agentStatusRow === null && agentOptions.length > 0
  // Short last rows keep empty slots so every tile stays a third of the row wide.
  const agentRows: { options: MobileNewTabAgentOption[]; emptySlots: string[] }[] = []
  for (let start = 0; start < agentOptions.length; start += AGENT_GRID_COLUMNS) {
    const options = agentOptions.slice(start, start + AGENT_GRID_COLUMNS)
    const emptySlots: string[] = []
    for (let column = options.length; column < AGENT_GRID_COLUMNS; column += 1) {
      emptySlots.push(`empty:${column}`)
    }
    agentRows.push({ options, emptySlots })
  }
  const iconColor = colors.textSecondary
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const run = afterCloseRef.current
        afterCloseRef.current = null
        run?.()
      }}
      dragContentToDismiss
    >
      <SheetHeader
        title={t('session.sheets.newTab', 'New Tab')}
        {...(workspaceName ? { subtitle: workspaceName } : {})}
        onClose={onClose}
      />
      {showAgentGrid || agentStatusRow || leadingAgentActions.length > 0 ? (
        <SectionHeader title={t('session.sheets.agents', 'Agents')} first />
      ) : null}
      {leadingAgentActions.length > 0 ? <ActionSheetContent actions={leadingAgentActions} /> : null}
      {agentStatusRow ? <ActionSheetContent actions={[agentStatusRow]} /> : null}
      {showAgentGrid && surfaceChoice ? (
        <MobileSegmentedControl
          segments={[
            { value: 'chat', label: t('session.sheets.chat', 'Chat') },
            { value: 'terminal', label: t('session.sheets.cli', 'CLI') }
          ]}
          selected={surfaceChoice.selected}
          onSelect={surfaceChoice.onSelect}
          fill
          onSheet
          testIDPrefix="new-tab-agent-surface-"
          style={styles.surfaceChoice}
        />
      ) : null}
      {showAgentGrid ? (
        <View style={styles.grid}>
          {agentRows.map((row) => (
            <View key={row.options.map((option) => option.agent).join(':')} style={styles.gridRow}>
              {row.options.map((option) => (
                <Pressable
                  key={option.agent}
                  onPress={() =>
                    closeAndRun(() => onCreateAgent(option.agent, option.nativeChatDefault))
                  }
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  style={styles.tile}
                >
                  {({ pressed }) => (
                    <>
                      {pressed ? <View style={styles.tilePressed} /> : null}
                      <MobileAgentIcon agentId={option.agent} size={22} />
                      <Text style={styles.tileLabel} numberOfLines={1}>
                        {option.label}
                      </Text>
                      {surfaceChoice?.selected === 'chat' && option.cliOnly ? (
                        <Text style={styles.tileNote} numberOfLines={1}>
                          {t('session.sheets.cliOnly', 'CLI only')}
                        </Text>
                      ) : null}
                    </>
                  )}
                </Pressable>
              ))}
              {row.emptySlots.map((slot) => (
                <View key={slot} style={styles.tileSpacer} />
              ))}
            </View>
          ))}
        </View>
      ) : null}
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.actions}>
        {terminalShells.length > 0 ? (
          terminalShells.map((shell) => (
            <ListRow
              key={shell}
              title={t('session.sheets.terminalWithShell', 'Terminal: {{shell}}', {
                shell: windowsShellLabel(shell, t)
              })}
              leading={<SquareTerminal size={16} color={iconColor} />}
              onPress={() => closeAndRun(() => onCreateTerminal(shell))}
            />
          ))
        ) : (
          <ListRow
            key="terminal"
            title={t('session.sheets.terminal', 'Terminal')}
            leading={<SquareTerminal size={16} color={iconColor} />}
            onPress={() => closeAndRun(() => onCreateTerminal())}
          />
        )}
        {canCreateBrowser ? (
          <ListRow
            key="browser"
            title={t('session.sheets.browser', 'Browser')}
            leading={<Globe size={16} color={iconColor} />}
            navigates
            onPress={() => closeThen(onCreateBrowser)}
          />
        ) : null}
        {canCreateBrowser && browserProfileLabel !== null ? (
          <ListRow
            key="browserProfile"
            title={t('session.browserProfile.title', 'Profile')}
            leading={<UserRound size={16} color={iconColor} />}
            value={browserProfileLabel}
            navigates
            onPress={() => closeThen(onChooseBrowserProfile)}
          />
        ) : null}
        {canCreateMarkdownNote ? (
          <ListRow
            key="markdownNote"
            title={t('session.sheets.markdownNote', 'Markdown Note')}
            leading={<FileText size={16} color={iconColor} />}
            onPress={() => closeAndRun(onCreateMarkdownNote)}
          />
        ) : null}
      </ListGroup>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  grid: { gap: spacing.sm },
  gridRow: { flexDirection: 'row', gap: spacing.sm },
  tile: {
    flex: 1,
    minWidth: 0,
    height: 78,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  // Same wash as a pressed ListRow, laid over the tile so its own fill stays underneath.
  tilePressed: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.translucentFill
  },
  tileLabel: { fontSize: 13.5, fontWeight: '600', color: colors.textPrimary, maxWidth: '100%' },
  // Sits in the tile's gap, so a noted tile keeps the others' height.
  tileNote: { fontSize: 11, color: colors.textMuted, marginTop: -spacing.xs, maxWidth: '100%' },
  surfaceChoice: { marginBottom: spacing.sm },
  // Padded like a tile: flex shares space after padding, so a bare spacer would widen its row's tiles.
  tileSpacer: { flex: 1, paddingHorizontal: spacing.sm },
  actions: { marginTop: spacing.lg }
}))
