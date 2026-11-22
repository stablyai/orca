// Connectors' Linear and GitHub rows: one per Linear workspace and per GitHub org, each with the status
// the owner acts on (the desktop's BotLinearCard and BotGitHubCard faces).
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import type { ReactNode } from 'react'
import { botLinearWorkspaces, botMembersFrom, botSlackApps } from '../../../../src/shared/bot-types'
import type { ConnectorGitHubState } from '../../../../src/shared/connector-bot-github-contract'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow } from '../../components/list/ListGroup'
import type { Translate } from '../../i18n/mobile-i18n'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import type { ConnectorPage } from './connector-pages'
import type { PhoneLinearView } from './use-phone-connector-account'

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

/** "Slack · Stably", or the service alone. */
export function connectorTitle(
  service: string,
  place: string | null | undefined,
  t: Translate
): string {
  return place ? `${service}${t('bots.connector.titleSeparator', ' · ')}${place}` : service
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

export function linearGitHubRows(input: {
  bot: PhoneBot
  linear: PhoneLinearView
  githubState: ConnectorGitHubState | null
  githubOrgs: ConnectorGitHubState['installations']
  setPage: (page: ConnectorPage) => void
  /** Settings' save, which Add back uses; null while it can't save. */
  save: ((updates: BotUpdateParams['updates']) => unknown) | null
  t: Translate
}): ReactNode[] {
  const { bot, githubState, githubOrgs, setPage, t } = input
  const linearState = input.linear.status === 'ready' ? input.linear.value : null
  const linearStatus = (workspaceId: string): string | undefined => {
    const linked = linearState?.workspaces.find((entry) => entry.workspaceId === workspaceId)
    return !linearState
      ? undefined
      : !linked
        ? t('settings.bots.linearStatus.unlinked', 'Not linked')
        : linked.installed
          ? undefined
          : t('settings.bots.linearStatus.notInstalled', 'Orca not installed')
  }
  const githubStatus =
    !githubState || githubOrgs.length > 0
      ? undefined
      : githubState.account
        ? t('settings.bots.githubStatus.notInstalled', 'Orca not installed')
        : t('settings.bots.githubStatus.unlinked', 'Not linked')
  const rows: ReactNode[] = []
  for (const workspace of botLinearWorkspaces(bot)) {
    rows.push(
      <ListRow
        key={`linear:${workspace.workspaceId}`}
        leading={<MobileConnectorSourceIcon source="linear" size={20} />}
        title={connectorTitle(BOT_CONNECTOR_NAMES.linear, workspace.workspaceName, t)}
        subtitle={
          workspace.urlKey
            ? t('bots.linear.address', 'linear.app/{{urlKey}}', { urlKey: workspace.urlKey })
            : undefined
        }
        subtitleLines={1}
        value={linearStatus(workspace.workspaceId)}
        navigates
        onPress={() => setPage({ kind: 'linear', workspaceId: workspace.workspaceId })}
      />
    )
  }
  if (bot.github) {
    // One row per org once linked and installed, as the desktop; until then, GitHub as a whole.
    const orgs = githubOrgs.length > 0 ? githubOrgs : [null]
    for (const org of orgs) {
      rows.push(
        <ListRow
          key={`github:${org?.installationId ?? ''}`}
          leading={<MobileConnectorSourceIcon source="github" size={20} />}
          title={connectorTitle(
            BOT_CONNECTOR_NAMES.github,
            orgs.length > 1 ? org?.accountLogin : null,
            t
          )}
          subtitle={
            org
              ? (org.repositories?.map((repository) => repository.fullName).join(', ') ??
                t('bots.github.allRepositoriesShort', 'all repositories'))
              : undefined
          }
          subtitleLines={1}
          value={githubStatus}
          navigates
          onPress={() => setPage({ kind: 'github', installationId: org?.installationId ?? null })}
        />
      )
    }
  }
  // Orgs taken off the bot that still have Orca installed (RemovedGitHubOrgs).
  const removed = bot.github?.removedInstallationIds ?? []
  for (const org of (githubState?.account ? githubState.installations : []).filter((entry) =>
    removed.includes(entry.installationId)
  )) {
    const save = input.save
    rows.push(
      <ListRow
        key={`github-removed:${org.installationId}`}
        leading={<MobileConnectorSourceIcon source="github" size={20} />}
        title={connectorTitle(BOT_CONNECTOR_NAMES.github, org.accountLogin, t)}
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
    )
  }
  return rows
}
