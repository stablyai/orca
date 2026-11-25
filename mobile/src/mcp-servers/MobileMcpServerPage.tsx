// One server's page: how it connects (its account, or its command or address), where it's on, a
// switch per installed agent, and Remove. A server from a plugin is the plugin's to change or remove.
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, type HostInstance } from 'react-native'
import { LogOut, MoreHorizontal, RefreshCw } from '../components/icons/app-icons'
import type { BotToolDetails } from '../../../src/shared/bot-tools'
import { ListRow, SectionHeader } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  mcpServerDetailsRead,
  type PhoneMcpServer,
  type PhoneMcpServerList
} from './mcp-server-operations'
import { McpDetailRow, McpStatusDot } from './mcp-server-row-parts'
import { McpPageFrame } from './McpPageFrame'
import { mcpServerAddress, mcpServerTitle, mcpWorkspacesValue } from './mcp-server-words'
import { mcpAgentName, type useMcpServerActions } from './use-mcp-server-actions'

type Actions = ReturnType<typeof useMcpServerActions>

export function MobileMcpServerPage(props: {
  client: RpcClient | null
  server: PhoneMcpServer
  list: PhoneMcpServerList
  agents: readonly string[] | null
  agentsFailed: boolean
  workspaceNames: ReadonlyMap<string, string>
  online: boolean
  actions: Actions
  onBack: () => void
  onWorkspaces: () => void
  onSignIn: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { server, actions, list } = props
  const title = mcpServerTitle(server)
  const details = useServerDetails(props.client, server)
  const moreRef = useRef<HostInstance>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const signIn = server.signIn
  const needsSignIn = signIn !== undefined && signIn.state !== 'signed-in'
  const locked = !props.online
  const agents = props.agents ?? []
  const off = agents.filter((agent) => server.agentsOff.includes(agent))
  const menu =
    signIn && signIn.state !== 'signed-out'
      ? [
          {
            id: 'again',
            label: t('mcpServers.signInAgain', 'Sign in again'),
            icon: RefreshCw,
            closeBeforePress: true,
            onPress: props.onSignIn
          },
          {
            id: 'out',
            label: t('mcpServers.signOut', 'Sign out'),
            icon: LogOut,
            closeBeforePress: true,
            onPress: () => actions.signOut(server)
          }
        ]
      : []
  const workspacesRow = (
    <ListRow
      key="workspaces"
      title={t('mcpServers.workspaces', 'Workspaces')}
      value={mcpWorkspacesValue(server.workspaces, props.workspaceNames, t)}
      navigates
      disabled={locked}
      onPress={props.onWorkspaces}
    />
  )
  return (
    <McpPageFrame
      title={title}
      subtitle={mcpServerAddress(server, true)}
      onBack={props.onBack}
      trailing={
        menu.length > 0 ? (
          <NavBarButton
            ref={moreRef}
            icon={MoreHorizontal}
            accessibilityLabel={t('mcpServers.moreFor', 'More for {{name}}', { name: title })}
            onPress={() => setMenuOpen(true)}
            active={menuOpen}
            disabled={locked}
          />
        ) : undefined
      }
      footer={
        needsSignIn ? (
          <SheetPrimaryButton
            label={t('mcpServers.signIn', 'Sign in')}
            disabled={locked}
            onPress={props.onSignIn}
          />
        ) : undefined
      }
    >
      {signIn ? (
        <SettingsSection first>
          <ListRow
            key="account"
            title={t('mcpServers.account', 'Account')}
            subtitle={needsSignIn ? t('mcpServers.needsSignIn', 'Needs sign-in') : undefined}
            subtitleIcon={needsSignIn ? <McpStatusDot tone="amber" /> : undefined}
            value={needsSignIn ? undefined : t('mcpServers.signedIn', 'Signed in')}
          />
          {workspacesRow}
        </SettingsSection>
      ) : (
        <>
          {details ? <SettingsSection first>{detailRows(details, t)}</SettingsSection> : null}
          <SettingsSection first={!details}>{workspacesRow}</SettingsSection>
        </>
      )}
      <SectionHeader
        title={t('mcpServers.agents', 'Agents')}
        trailing={
          off.length > 0 ? (
            <Pressable
              onPress={() => actions.setAgents(server, off, true)}
              disabled={locked}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => pressed && pressedStyle}
            >
              <Text style={styles.turnAllOn}>{t('mcpServers.turnAllOn', 'Turn all on')}</Text>
            </Pressable>
          ) : undefined
        }
      />
      {props.agentsFailed ? (
        <SettingsNote error>
          {t('mcpServers.agentsUnread', 'Couldn’t read the agents on this computer.')}
        </SettingsNote>
      ) : (
        <SettingsSection first>
          {agents.map((agent) => {
            const problem = list.agentProblems?.[agent]
            const on = !server.agentsOff.includes(agent)
            const name = mcpAgentName(agent)
            return (
              <ListRow
                key={agent}
                title={name}
                subtitle={problem?.detail}
                subtitleIcon={
                  problem?.kind === 'blocked' ? <McpStatusDot tone="amber" /> : undefined
                }
                // The host's short line; two at most, as the org-policy one takes.
                subtitleLines={2}
                leading={<MobileAgentIcon agentId={agent} size={18} />}
                accessory={
                  <MobileSwitch
                    value={on}
                    disabled={locked}
                    accessibilityLabel={name}
                    onValueChange={(next) => actions.setAgents(server, [agent], next)}
                  />
                }
              />
            )
          })}
        </SettingsSection>
      )}
      {server.transport === 'command' ? (
        <SettingsSection title={t('mcpServers.advanced', 'Advanced')}>
          <ListRow
            title={t('mcpServers.sharedProcess', 'Share one process across agents')}
            wrapTitle
            subtitle={t(
              'mcpServers.sharedProcessNote',
              'Uses less memory. Runs outside the workspace folder.'
            )}
            accessory={
              <MobileSwitch
                value={server.sharedProcess}
                disabled={locked}
                accessibilityLabel={t(
                  'mcpServers.sharedProcess',
                  'Share one process across agents'
                )}
                onValueChange={(next) => actions.setShared(server, next)}
              />
            }
          />
        </SettingsSection>
      ) : null}
      {server.plugin ? null : (
        <SettingsSection>
          <ListRow
            title={t('mcpServers.removeServer', 'Remove server')}
            destructive
            disabled={locked}
            onPress={() => actions.remove(server, props.onBack)}
          />
        </SettingsSection>
      )}
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        onClose={() => setMenuOpen(false)}
        groups={[menu]}
      />
    </McpPageFrame>
  )
}

/** How a server Orca doesn't sign in to runs: its command or address, with secrets as names only. */
function detailRows(details: BotToolDetails, t: ReturnType<typeof useMobileTranslation>) {
  const { server } = details
  if ('url' in server) {
    return [
      <McpDetailRow key="url" label={t('mcpServers.url', 'URL')} value={server.url} />,
      ...server.headers.map((header) => (
        <McpDetailRow key={`h:${header.key}`} label={header.key} value="" secret />
      ))
    ]
  }
  return [
    <McpDetailRow
      key="command"
      label={t('mcpServers.command', 'Command')}
      value={server.command}
    />,
    ...(server.args.length > 0
      ? [
          <McpDetailRow
            key="args"
            label={t('mcpServers.arguments', 'Arguments')}
            value={server.args.join(' ')}
          />
        ]
      : []),
    ...server.env.map((env) => (
      <McpDetailRow key={`e:${env.key}`} label={env.key} value="" secret />
    ))
  ]
}

/** The saved command or address, read again when the server changes; null until read. */
function useServerDetails(client: RpcClient | null, server: PhoneMcpServer): BotToolDetails | null {
  const [details, setDetails] = useState<BotToolDetails | null>(null)
  const signsIn = server.signIn !== undefined
  useEffect(() => {
    if (!client || signsIn) {
      return undefined
    }
    let live = true
    void mcpServerDetailsRead
      .request(client, { id: server.id })
      .then((reply) => live && setDetails(mcpServerDetailsRead.interpret(reply)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, server.id, server.detail, signsIn])
  return signsIn ? null : details
}

const styles = themedStyleSheet(() => ({
  turnAllOn: { fontSize: 13, fontWeight: '600', color: colors.textPrimary }
}))
