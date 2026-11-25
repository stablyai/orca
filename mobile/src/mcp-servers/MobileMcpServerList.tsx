// The host's MCP servers: yours (with Add), a plugin's, and the ones set up inside its agents, each
// group a grouped list like Settings › Tools, with the agents a server is on for on the right.
import { useRef, useState } from 'react'
import { Pressable, type HostInstance } from 'react-native'
import { ArrowDownToLine, Copy, MoreHorizontal, Plus } from 'lucide-react-native'
import type { BotToolProblem } from '../../../src/shared/bot-tools'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { MobileStateButton } from '../components/feedback/MobileStateView'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { PhoneDiscoveredMcpServer, PhoneMcpServer } from './mcp-server-operations'
import { McpServerMark, McpStatusDot } from './mcp-server-row-parts'
import {
  isAllMcpWorkspaces,
  mcpAgentsValue,
  mcpServerAddress,
  mcpServerTitle,
  mcpWorkspacesValue
} from './mcp-server-words'
import { mcpAgentName } from './use-mcp-server-actions'

export function MobileMcpServerList(props: {
  servers: readonly PhoneMcpServer[]
  discovered: readonly PhoneDiscoveredMcpServer[] | null
  problems: Readonly<Record<string, BotToolProblem>>
  agents: readonly string[] | null
  workspaceNames: ReadonlyMap<string, string>
  online: boolean
  onOpen: (server: PhoneMcpServer) => void
  onSignIn: (server: PhoneMcpServer) => void
  onAdd: () => void
  onMove: (entry: PhoneDiscoveredMcpServer) => void
  onCopy: (entry: PhoneDiscoveredMcpServer) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const yours = props.servers.filter((server) => !server.plugin)
  const fromPlugins = props.servers.filter((server) => server.plugin)
  const row = (server: PhoneMcpServer) => (
    <McpServerRow
      key={server.id}
      server={server}
      problem={props.problems[server.id]}
      agents={props.agents}
      workspaceNames={props.workspaceNames}
      online={props.online}
      onOpen={() => props.onOpen(server)}
      onSignIn={() => props.onSignIn(server)}
    />
  )
  return (
    <>
      <SettingsSection
        title={t('mcpServers.yours', 'Yours')}
        first
        separatorInset={LIST_LEADING_INSET}
      >
        {yours.map(row)}
        <ListRow
          key="add"
          title={t('mcpServers.addServer', 'Add a server')}
          leading={<Plus size={18} color={colors.textMuted} />}
          disabled={!props.online}
          onPress={props.onAdd}
        />
      </SettingsSection>
      {fromPlugins.length > 0 ? (
        <SettingsSection
          title={t('mcpServers.fromPlugins', 'From plugins')}
          separatorInset={LIST_LEADING_INSET}
        >
          {fromPlugins.map(row)}
        </SettingsSection>
      ) : null}
      {props.discovered && props.discovered.length > 0 ? (
        <SettingsSection
          title={t('mcpServers.inYourAgents', 'In your agents')}
          separatorInset={LIST_LEADING_INSET}
        >
          {props.discovered.map((entry) => (
            <DiscoveredRow
              key={entry.key}
              entry={entry}
              online={props.online}
              onMove={() => props.onMove(entry)}
              onCopy={() => props.onCopy(entry)}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  )
}

function McpServerRow(props: {
  server: PhoneMcpServer
  problem: BotToolProblem | undefined
  agents: readonly string[] | null
  workspaceNames: ReadonlyMap<string, string>
  online: boolean
  onOpen: () => void
  onSignIn: () => void
}) {
  const t = useMobileTranslation()
  const { server, problem } = props
  const needsSignIn = server.signIn !== undefined && server.signIn.state !== 'signed-in'
  const failed = !needsSignIn && problem?.kind === 'failed'
  const where = isAllMcpWorkspaces(server.workspaces)
    ? null
    : mcpWorkspacesValue(server.workspaces, props.workspaceNames, t)
  const line =
    server.plugin?.name ?? [mcpServerAddress(server, false), where].filter(Boolean).join(' · ')
  return (
    <ListRow
      title={mcpServerTitle(server)}
      subtitle={
        needsSignIn
          ? t('mcpServers.needsSignIn', 'Needs sign-in')
          : failed
            ? t('mcpServers.wontStart', 'Won’t start')
            : line
      }
      subtitleIcon={
        needsSignIn ? (
          <McpStatusDot tone="amber" />
        ) : failed ? (
          <McpStatusDot tone="red" />
        ) : undefined
      }
      subtitleColor={failed ? colors.statusRed : undefined}
      subtitleLines={1}
      leading={<McpServerMark server={server} />}
      value={
        needsSignIn ? undefined : (mcpAgentsValue(server.agentsOff, props.agents, t) ?? undefined)
      }
      accessory={
        needsSignIn ? (
          <MobileStateButton
            inRow
            label={t('mcpServers.signIn', 'Sign in')}
            disabled={!props.online}
            onPress={props.onSignIn}
          />
        ) : undefined
      }
      navigates={!needsSignIn}
      onPress={props.onOpen}
    />
  )
}

function DiscoveredRow(props: {
  entry: PhoneDiscoveredMcpServer
  online: boolean
  onMove: () => void
  onCopy: () => void
}) {
  const t = useMobileTranslation()
  const anchor = useRef<HostInstance>(null)
  const [open, setOpen] = useState(false)
  const { entry } = props
  const agents = entry.agents.map(mcpAgentName).join(', ')
  const only =
    entry.projectNames.length > 0
      ? t('mcpServers.projectsOnly', '{{projects}} only', {
          projects: new Intl.ListFormat(getUiIntlLocale(), { type: 'unit', style: 'short' }).format(
            entry.projectNames
          )
        })
      : null
  return (
    <ListRow
      title={entry.name}
      subtitle={[agents, only].filter(Boolean).join(' · ')}
      subtitleLines={1}
      leading={<McpServerMark server={entry} />}
      accessory={
        entry.movable ? (
          <>
            <Pressable
              ref={anchor}
              style={({ pressed }) => [{ padding: 7, marginRight: -7 }, pressed && pressedStyle]}
              onPress={() => setOpen(true)}
              disabled={!props.online}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t('mcpServers.moreFor', 'More for {{name}}', {
                name: entry.name
              })}
            >
              <MoreHorizontal size={18} color={colors.textSecondary} />
            </Pressable>
            <PullDownMenu
              visible={open}
              anchorRef={anchor}
              onClose={() => setOpen(false)}
              groups={[
                [
                  {
                    id: 'move',
                    label: t('mcpServers.moveToOrca', 'Move to Orca'),
                    icon: ArrowDownToLine,
                    closeBeforePress: true,
                    onPress: props.onMove
                  },
                  {
                    id: 'copy',
                    label: t('mcpServers.copyToOrca', 'Copy to Orca'),
                    icon: Copy,
                    closeBeforePress: true,
                    onPress: props.onCopy
                  }
                ]
              ]}
            />
          </>
        ) : undefined
      }
    />
  )
}
