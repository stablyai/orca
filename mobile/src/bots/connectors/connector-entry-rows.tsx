// Connectors' rows: the shared list's entries (the desktop's BotConnectorsSection rows), each with the
// status the owner acts on, as the phone's reads give it.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { Fragment, type ReactNode } from 'react'
import { Blocks } from 'lucide-react-native'
import { botLinearWorkspaces, botMembersFrom, botSlackApps } from '../../../../src/shared/bot-types'
import {
  botConnectorEntries,
  type BotConnectorEntry
} from '../../../../src/shared/bots/bot-connector-entries'
import { botConnectorTitleLine } from '../../../../src/shared/bots/bot-connector-titles'
import type { BotToolProblem } from '../../../../src/shared/bot-tools'
import type { PhoneOwnTool } from '../tools/bot-tool-operations'
import type { ConnectorGitHubState } from '../../../../src/shared/connector-bot-github-contract'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow } from '../../components/list/ListGroup'
import type { Translate } from '../../i18n/mobile-i18n'
import type { MobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import { colors } from '../../theme/mobile-theme'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import { ToolRow } from '../tools/MobileBotToolsPage'
import type { ConnectorPage } from './connector-pages'
import { slackRowFace } from './mobile-slack-copy'
import type { PhoneSlackView } from './use-phone-bot-slack'
import type { PhoneLinearView } from './use-phone-connector-account'
import { botMcpAppLine } from '../../../../src/shared/bots/bot-app-lines'
import { AppLogoMark } from './MobileBotAddConnector'

const ICON = 20

type PhoneSignIn = NonNullable<MobileComposio['connections']>['connections'][number]

export type PhoneConnectorEntry = BotConnectorEntry<PhoneSignIn, PhoneOwnTool>

/** The services the bot's own record says it has, for the Settings row. */
export function connectorNames(bot: PhoneBot, hasHooks: boolean, t: Translate): string[] {
  return [
    (botSlackApps(bot).length > 0 || botMembersFrom(bot.members, 'slack').length > 0) &&
      BOT_CONNECTOR_NAMES.slack,
    botLinearWorkspaces(bot).length > 0 && BOT_CONNECTOR_NAMES.linear,
    bot.github !== null && BOT_CONNECTOR_NAMES.github,
    bot.google === true && BOT_CONNECTOR_NAMES.google,
    hasHooks && t('bots.webhooks.name', 'Webhooks')
  ].filter((name): name is string => typeof name === 'string')
}

/** The orgs the bot answers in: installed where the host is linked, less the ones removed from it. */
export function githubOrgsOf(
  bot: PhoneBot,
  state: ConnectorGitHubState | null
): ConnectorGitHubState['installations'] {
  return (state?.account ? state.installations : []).filter(
    (entry) => !(bot.github?.removedInstallationIds ?? []).includes(entry.installationId)
  )
}

export type ConnectorRowsInput = {
  bot: PhoneBot
  slack: PhoneSlackView
  linear: PhoneLinearView
  githubState: ConnectorGitHubState | null
  /** The emails of the host's Google accounts read so far. */
  googleEmails: readonly string[]
  composio: MobileComposio
  /** The bot's tools and their check; null until read. */
  tools: { own: readonly PhoneOwnTool[]; problems: Record<string, BotToolProblem> | null } | null
  webhooksRow: ReactNode
  rereadComposio: () => void
  hostName: string
  online: boolean
  setPage: (page: ConnectorPage) => void
  /** Settings' save, which Add back uses; null while it can't save. */
  save: ((updates: BotUpdateParams['updates']) => unknown) | null
  t: Translate
}

/** The reads the shared list is made from. */
export type PhoneConnectorSources = Pick<
  ConnectorRowsInput,
  | 'bot'
  | 'slack'
  | 'linear'
  | 'githubState'
  | 'googleEmails'
  | 'composio'
  | 'tools'
  | 'hostName'
  | 't'
>

/** The shared list from the phone's reads; Connectors draws it, Needs you lists what needs the owner. */
export function phoneConnectorEntries(input: PhoneConnectorSources): PhoneConnectorEntry[] {
  const { bot, t } = input
  const linear = input.linear.status === 'ready' ? input.linear.value : null
  return botConnectorEntries(bot, {
    slack: (teamId) => {
      const face = slackRowFace(input.slack, teamId, input.hostName, t)
      return {
        workspace: face.workspace,
        needsOwner: face.next !== null && face.next !== 'retry',
        updateNeeded: face.next === 'update'
      }
    },
    linearNeedsOwner: (workspace) => linearStatus(linear, workspace.workspaceId, t) !== undefined,
    github: {
      installations: input.githubState?.account ? input.githubState.installations : [],
      needsOwner: githubStatus(input.githubState, [], t) !== undefined
    },
    // Listed before Google is read, as the phone always has: its page says what's wrong.
    google: { emails: input.googleEmails },
    composio: {
      key: input.composio.status?.key,
      added: input.composio.status?.added === true,
      unread: input.composio.unread,
      connections: input.composio.connections?.connections ?? []
    },
    tools: input.tools ? { own: input.tools.own, problems: input.tools.problems ?? {} } : null,
    words: {
      webhooks: t('bots.webhooks.name', 'Webhooks'),
      viaComposio: t('bots.composio.viaComposio', 'via Composio'),
      composioApps: t('bots.composio.toolName', 'Composio apps'),
      titleSeparator: t('bots.connector.titleSeparator', ' · ')
    }
  })
}

function linearStatus(
  state: Extract<PhoneLinearView, { status: 'ready' }>['value'] | null,
  workspaceId: string,
  t: Translate
): string | undefined {
  const linked = state?.workspaces.find((entry) => entry.workspaceId === workspaceId)
  return !state
    ? undefined
    : !linked
      ? t('settings.bots.linearStatus.unlinked', 'Not linked')
      : linked.installed
        ? undefined
        : t('settings.bots.linearStatus.notInstalled', 'Orca not installed')
}

function githubStatus(
  state: ConnectorGitHubState | null,
  orgs: ConnectorGitHubState['installations'],
  t: Translate
): string | undefined {
  return !state || orgs.length > 0
    ? undefined
    : state.account
      ? t('settings.bots.githubStatus.notInstalled', 'Orca not installed')
      : t('settings.bots.githubStatus.unlinked', 'Not linked')
}

/** Every row of the Connectors list, in the shared list's order. */
export function connectorRows(input: ConnectorRowsInput): ReactNode[] {
  const { bot, setPage, t } = input
  const linear = input.linear.status === 'ready' ? input.linear.value : null
  const githubOrgs = githubOrgsOf(bot, input.githubState)
  const separator = t('bots.connector.titleSeparator', ' · ')
  const mark = (source: 'slack' | 'linear' | 'github') => (
    <MobileConnectorLogo source={source} size={ICON} />
  )
  const composioFix = (problem: 'key' | 'unread') => {
    const fix =
      problem === 'key'
        ? {
            label: t('bots.composio.fixKey', 'Fix key'),
            onPress: () => setPage({ kind: 'composio-key' })
          }
        : { label: t('bots.composio.checkAgain', 'Check again'), onPress: input.rereadComposio }
    return {
      onPress: fix.onPress,
      button: (
        <MobileBotTextButton label={fix.label} disabled={!input.online} onPress={fix.onPress} />
      )
    }
  }
  const rows: ReactNode[] = []
  for (const entry of phoneConnectorEntries(input)) {
    const title = botConnectorTitleLine(entry.title, separator)
    switch (entry.kind) {
      case 'slack': {
        const face = entry.teamId
          ? slackRowFace(input.slack, entry.teamId, input.hostName, t)
          : null
        rows.push(
          <ListRow
            key={entry.key}
            leading={mark('slack')}
            title={title}
            subtitle={face?.description}
            subtitleLines={1}
            value={face?.status?.label}
            navigates
            onPress={() => setPage({ kind: 'slack', teamId: entry.teamId })}
          />
        )
        break
      }
      case 'linear': {
        const { workspaceId, urlKey } = entry.linear
        rows.push(
          <ListRow
            key={entry.key}
            leading={mark('linear')}
            title={title}
            subtitle={
              urlKey ? t('bots.linear.address', 'linear.app/{{urlKey}}', { urlKey }) : undefined
            }
            subtitleLines={1}
            value={linearStatus(linear, workspaceId, t)}
            navigates
            onPress={() => setPage({ kind: 'linear', workspaceId })}
          />
        )
        break
      }
      case 'github': {
        const org = entry.installation
        rows.push(
          <ListRow
            key={entry.key}
            leading={mark('github')}
            title={title}
            subtitle={
              org
                ? (org.repositories?.map((repository) => repository.fullName).join(', ') ??
                  t('bots.github.allRepositoriesShort', 'all repositories'))
                : undefined
            }
            subtitleLines={1}
            value={githubStatus(input.githubState, githubOrgs, t)}
            navigates
            onPress={() => setPage({ kind: 'github', installationId: org?.installationId ?? null })}
          />
        )
        // Orgs taken off the bot that still have Orca installed (RemovedGitHubOrgs), after its last org.
        if (!org || org.installationId === githubOrgs.at(-1)?.installationId) {
          rows.push(...removedGitHubRows(input))
        }
        break
      }
      case 'google':
        rows.push(
          <ListRow
            key={entry.key}
            leading={<MobileConnectorLogo source="google" size={ICON} />}
            title={title}
            subtitle={input.googleEmails.length > 0 ? input.googleEmails.join(', ') : undefined}
            subtitleLines={1}
            navigates
            onPress={() => setPage({ kind: 'google' })}
          />
        )
        break
      case 'webhooks':
        if (input.webhooksRow) {
          rows.push(<Fragment key={entry.key}>{input.webhooksRow}</Fragment>)
        }
        break
      case 'composio': {
        const { connection, problem } = entry
        const via = t('bots.composio.viaComposio', 'via Composio')
        rows.push(
          <ListRow
            key={entry.key}
            leading={<AppLogoMark slug={connection.app} />}
            title={title}
            subtitle={
              problem
                ? `${composioProblemLine(problem, t)}${separator}${via}`
                : connection.status === 'active'
                  ? [connection.label, via].filter(Boolean).join(separator)
                  : t('bots.composio.signedOut', 'Signed out · {{via}}', { via })
            }
            subtitleColor={problem ? colors.agentQuestion : undefined}
            subtitleLines={1}
            // As the desktop's row: a Composio problem's one fix sits on every app it pauses.
            accessory={problem ? composioFix(problem).button : undefined}
            navigates={!problem}
            onPress={() =>
              setPage({ kind: 'composio', app: connection.app, label: connection.label })
            }
          />
        )
        break
      }
      case 'composio-problem': {
        const { problem } = entry
        const fix = composioFix(problem)
        rows.push(
          <ListRow
            key={entry.key}
            leading={<Blocks size={ICON} color={colors.textSecondary} />}
            title={title}
            subtitle={composioProblemLine(problem, t)}
            subtitleColor={colors.agentQuestion}
            subtitleLines={1}
            onPress={fix.onPress}
            accessory={fix.button}
          />
        )
        break
      }
      case 'app':
        rows.push(
          <ToolRow
            key={entry.key}
            title={title}
            // As the desktop's: a listed app that signs in in a browser reads as signed in once checked.
            line={
              entry.app?.signIn === 'browser' && !entry.problem && input.tools?.problems != null
                ? t('bots.tools.face.signedIn', 'Signed in')
                : entry.app
                  ? botMcpAppLine(entry.app, t)
                  : undefined
            }
            leading={entry.app ? <AppLogoMark slug={entry.app.id} /> : undefined}
            tool={entry.tool}
            problem={entry.problem}
            hostName={input.hostName}
            disabled={!input.online}
            onOpen={(signIn) => setPage({ kind: 'tool', name: entry.tool.name, signIn })}
          />
        )
        break
    }
  }
  return rows
}

function composioProblemLine(problem: 'key' | 'unread', t: Translate): string {
  return problem === 'key'
    ? t('bots.composio.keyRejected', 'Key not accepted')
    : t('bots.composio.signInsUnreadShort', 'Couldn’t read sign-ins')
}

/** Orgs taken off the bot that still have Orca installed, each with Add back. */
function removedGitHubRows(input: ConnectorRowsInput): ReactNode[] {
  const { bot, githubState, t } = input
  const removed = bot.github?.removedInstallationIds ?? []
  const save = input.save
  return (githubState?.account ? githubState.installations : [])
    .filter((entry) => removed.includes(entry.installationId))
    .map((org) => (
      <ListRow
        key={`github-removed:${org.installationId}`}
        leading={<MobileConnectorLogo source="github" size={ICON} />}
        title={`${BOT_CONNECTOR_NAMES.github}${t('bots.connector.titleSeparator', ' · ')}${org.accountLogin}`}
        accessory={
          <MobileBotTextButton
            label={t('bots.connectors.addBack', 'Add back')}
            accessibilityLabel={t('bots.connectors.addBackNamed', 'Add {{name}} back', {
              name: org.accountLogin
            })}
            disabled={!save}
            // Puts the bot back in the org with no GitHub trip.
            onPress={() =>
              save?.({
                github: {
                  removedInstallationIds: removed.filter((id) => id !== org.installationId)
                }
              })
            }
          />
        }
      />
    ))
}
