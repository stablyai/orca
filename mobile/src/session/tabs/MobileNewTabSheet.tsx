import { useRef } from 'react'
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
import { MobileAgentTileGrid } from '../agent-launch/MobileAgentTileGrid'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { MobileNewTabAgentOption } from '../agent-launch/mobile-new-tab-agent-options'
import type { NewTabAgentSurfaceChoice } from '../agent-launch/use-mobile-new-tab-agent-options'
import { MobileSegmentedControl } from '../../components/controls/MobileSegmentedControl'
import {
  WINDOWS_GIT_BASH_SHELL,
  type BuiltInWindowsTerminalShell
} from '../../../../src/shared/shell/launch/windows-terminal-shell'

/** A bot's home: a new Home Chat, then a side chat with the bot on each agent, in place of the agents. */
export type MobileNewTabBotActions = {
  homeChat: ActionSheetAction
  sideChatsTitle: string
  sideChats: ActionSheetAction[]
}

type Props = {
  visible: boolean
  workspaceName: string
  agentOptions: readonly MobileNewTabAgentOption[]
  /** Chat or CLI for the agents below; null where the host can't take a pick. */
  surfaceChoice: NewTabAgentSurfaceChoice | null
  /** Loading, none, other-server or error; shown instead of the agent grid. */
  agentStatusRow: ActionSheetAction | null
  bot: MobileNewTabBotActions | null
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
  bot,
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
  const showAgentGrid = bot === null && agentStatusRow === null && agentOptions.length > 0
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
        title={t('session.sheets.newTab', 'New tab')}
        {...(workspaceName ? { subtitle: workspaceName } : {})}
        onClose={onClose}
      />
      {bot ? (
        <>
          {/* The Home Chat's confirm opens once this sheet has gone. */}
          <ActionSheetContent
            actions={[{ ...bot.homeChat, onPress: () => closeThen(bot.homeChat.onPress) }]}
          />
          <SectionHeader title={bot.sideChatsTitle} />
          <ActionSheetContent
            actions={bot.sideChats.map((action) => ({
              ...action,
              onPress: () => closeAndRun(action.onPress)
            }))}
          />
        </>
      ) : null}
      {bot === null && (showAgentGrid || agentStatusRow) ? (
        <SectionHeader title={t('session.sheets.agents', 'Agents')} first />
      ) : null}
      {bot === null && agentStatusRow ? <ActionSheetContent actions={[agentStatusRow]} /> : null}
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
        <MobileAgentTileGrid
          options={agentOptions}
          showCliOnly={surfaceChoice?.selected === 'chat'}
          onPick={(option) =>
            closeAndRun(() => onCreateAgent(option.agent, option.nativeChatDefault))
          }
        />
      ) : null}
      {bot ? <SectionHeader title={t('session.sheets.more', 'More')} /> : null}
      <ListGroup separatorInset={LIST_LEADING_INSET} style={bot ? undefined : styles.actions}>
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
            title={t('session.sheets.markdownNote', 'Markdown note')}
            leading={<FileText size={16} color={iconColor} />}
            onPress={() => closeAndRun(onCreateMarkdownNote)}
          />
        ) : null}
      </ListGroup>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  surfaceChoice: { marginBottom: spacing.sm },
  actions: { marginTop: spacing.lg }
}))
