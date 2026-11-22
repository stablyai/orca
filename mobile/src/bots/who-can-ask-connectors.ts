// Who can ask, one list per Slack workspace, Linear workspace and GitHub org the agent is in, as the
// desktop's BotWhoCanAskPage builds them (use-slack-who-can-ask, use-linear-who-can-ask,
// use-github-who-can-ask): who is listed, how to find more, and the words around them.
import {
  BOT_MAX_MEMBERS,
  botLinearWorkspaces,
  botMembersFrom,
  botSlackApps,
  gitHubMembersOf,
  linearMembersOf,
  slackMembersOf,
  type BotMember
} from '../../../src/shared/bot-types'
import { BOT_CONNECTOR_NAMES } from '../../../src/shared/bots/bot-templates'
import type { BotAccessConnector } from '../../../src/shared/bots/bot-access-reach'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import {
  gitHubLinkedAccounts,
  type ConnectorGitHubState
} from '../../../src/shared/connector-bot-github-contract'
import type { ConnectorLinearState } from '../../../src/shared/connector-bot-linear-contract'
import {
  slackTeamState,
  type BotSlackResult
} from '../../../src/shared/connector-bot-slack-contract'
import { CONNECTOR_CLIENT_LIMITS } from '../../../src/shared/connectors/connector-cloud-contract'
import type { Translate } from '../i18n/mobile-i18n'
import { hostReadClient } from '../query/host-read-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  gitHubUsersRead,
  linearMembersRead,
  slackMembersRead
} from './connectors/bot-connector-people-operations'
import { HOST_OFFLINE, slackCall } from './connectors/bot-slack-operations'
import { slackErrorMessage } from './connectors/mobile-slack-copy'
import type { PhoneSlackView } from './connectors/use-phone-bot-slack'
import type { PhoneBot } from './host-bots-operations'

/** People a search found; complete is false when the service has too many to read whole. */
export type WhoCanAskFound = {
  /** `app`: another Slack app's bot user, offered beside people. */
  members: { id: string; name: string; handle?: string; avatarUrl?: string; app?: true }[]
  complete: boolean
}

/** One connector's list, as the desktop's BotWhoCanAskService describes it. */
export type WhoCanAskConnector = {
  key: string
  kind: BotAccessConnector
  /** "Slack · Stably", over its list and the picker. */
  title: string
  /** For the access confirm: e.g. "Slack" and its workspace. */
  workspace: string | null
  listed: BotMember[]
  stamp: Pick<BotMember, 'source' | 'workspaceId'>
  /** How many people this connector takes, within the agent's BOT_MAX_MEMBERS overall. */
  max: number
  /** Null until the agent is reachable there; `notYet` says why, once `checking` is done. */
  search: ((query: string) => Promise<BotSlackResult<WhoCanAskFound>>) | null
  checking: boolean
  notYet: string
  errorMessage: (code: string) => string
  searchPlaceholder: string
  peopleHeading: string
  noMatch: (query: string) => { title: string; detail: string }
  /** Shown instead of people while the search is empty, for a service that can't list them. */
  idleHint?: { title: string; detail: string }
  /** The owner's own accounts there: found as the owner, never offered. */
  ownerIds: readonly string[]
  /** The Request access asks this list answers. */
  takes: (request: ConnectorAccessRequest) => boolean
}

const TAKES_NONE = () => false

function searchError(code: string, service: string, hostName: string, t: Translate): string {
  switch (code) {
    case HOST_OFFLINE:
      return t('bots.items.write.offline', '{{host}} is offline.', { host: hostName })
    case 'signed_out':
      return t(
        'bots.host.errors.signedOut',
        'Sign {{host}} in to Orca Cloud to connect {{service}}.',
        { host: hostName, service }
      )
    case 'rate_limited':
      return t('bots.slack.errors.rateLimited', 'Too many tries. Wait a minute, then try again.')
    default:
      return t('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

type LinkRead<T> = { value: T | null; checking: boolean }

/** Every list, from the agent and what the host's cloud says of its links. */
export function whoCanAskConnectors({
  client,
  bot,
  hostName,
  t,
  slack,
  linear: linearRead,
  github: githubRead
}: {
  client: RpcClient | null
  bot: PhoneBot
  hostName: string
  t: Translate
  slack: { view: PhoneSlackView }
  linear: LinkRead<ConnectorLinearState>
  github: LinkRead<ConnectorGitHubState>
}): WhoCanAskConnector[] {
  const slackApps = botSlackApps(bot)
  const linearLinks = botLinearWorkspaces(bot)
  const linear = linearRead.value
  const github = githubRead.value
  const separator = t('bots.connector.titleSeparator', ' · ')
  const titled = (service: string, place: string | null) =>
    place ? `${service}${separator}${place}` : service
  const inWorkspace = (place: string) => ({
    searchPlaceholder: t('bots.whoCanAsk.searchIn', 'Search people in {{workspace}}', {
      workspace: place
    }),
    peopleHeading: t('bots.whoCanAsk.peopleIn', 'People in {{workspace}}', { workspace: place })
  })
  const noOneNamed = (query: string, place: string) =>
    t('bots.whoCanAsk.noOneNamed', 'No one named “{{query}}” in {{workspace}}', {
      query,
      workspace: place
    })
  const connectors: WhoCanAskConnector[] = []

  const slackNotYet = t(
    'bots.whoCanAsk.needsSlack',
    'Add {{name}} to Slack first to pick people from your workspace.',
    { name: bot.name }
  )
  for (const app of slackApps) {
    const team = slack.view.status === 'ready' ? slackTeamState(slack.view.slack, app.teamId) : null
    const installed = team?.state === 'installed' ? team : null
    const workspace = installed ? (installed.teamName ?? installed.teamId) : null
    const place = workspace ?? BOT_CONNECTOR_NAMES.slack
    connectors.push({
      key: `slack:${app.teamId}`,
      kind: 'slack',
      title: titled(BOT_CONNECTOR_NAMES.slack, workspace),
      workspace,
      listed: slackMembersOf(bot, app.teamId),
      stamp: { source: 'slack', workspaceId: app.teamId },
      max: BOT_MAX_MEMBERS,
      search:
        installed && client
          ? (query) =>
              slackCall(
                () =>
                  slackMembersRead.request(hostReadClient(client), {
                    botId: bot.id,
                    query,
                    teamId: app.teamId
                  }),
                slackMembersRead.interpret
              )
          : null,
      checking: slack.view.status === 'loading',
      notYet: slackNotYet,
      errorMessage: (code) => slackErrorMessage(code, hostName, t),
      ...inWorkspace(place),
      noMatch: (query) => ({
        title: noOneNamed(query, place),
        detail: t(
          'bots.whoCanAsk.noMatchDetail',
          'Members, guests and people from other organizations in {{workspace}}’s Slack can be added. Anyone else gets a private note to ask you.',
          { workspace: place }
        )
      }),
      ownerIds: installed?.installerUserId ? [installed.installerUserId] : [],
      takes: installed
        ? (request) => request.source === 'slack' && request.workspaceId === installed.teamId
        : TAKES_NONE
    })
  }
  // People added in Slack stay listed after its app is removed, so they can be removed too.
  const slackLeft = botMembersFrom(bot.members, 'slack')
  if (slackApps.length === 0 && slackLeft.length > 0) {
    connectors.push(unreachable('slack', BOT_CONNECTOR_NAMES.slack, slackLeft, slackNotYet))
  }

  for (const link of linearLinks) {
    const owner = linear?.workspaces.find((entry) => entry.workspaceId === link.workspaceId)
    const workspace = link.urlKey
      ? `${link.workspaceName} (linear.app/${link.urlKey})`
      : link.workspaceName
    const place = link.workspaceName || workspace
    const { workspaceId } = link
    connectors.push({
      key: `linear:${workspaceId}`,
      kind: 'linear',
      title: titled(BOT_CONNECTOR_NAMES.linear, link.workspaceName || null),
      workspace,
      listed: linearMembersOf(bot.members, workspaceId),
      stamp: { source: 'linear', workspaceId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search:
        owner && client
          ? (query) =>
              slackCall(
                () => linearMembersRead.request(hostReadClient(client), { workspaceId, query }),
                linearMembersRead.interpret
              )
          : null,
      checking: linearRead.checking,
      notYet: t(
        'bots.linear.whoCanAsk.needsSetup',
        'Finish setup to link your Linear account in {{workspace}}, then pick people here.',
        { workspace }
      ),
      errorMessage: (code) => searchError(code, BOT_CONNECTOR_NAMES.linear, hostName, t),
      ...inWorkspace(place),
      noMatch: (query) => ({
        title: noOneNamed(query, place),
        detail: t(
          'bots.linear.whoCanAsk.noMatchDetail',
          'Members and guests of {{workspace}}’s Linear can be added. Anyone else gets a public reply to ask you.',
          { workspace: place }
        )
      }),
      ownerIds: owner ? [owner.userId] : [],
      takes: (request) => request.source === 'linear' && request.workspaceId === workspaceId
    })
  }

  if (bot.github) {
    const removed = bot.github.removedInstallationIds ?? []
    const orgs =
      github?.account && github.installations.length > 0
        ? github.installations.filter((entry) => !removed.includes(entry.installationId))
        : []
    const notYet = t(
      'bots.github.whoCanAsk.needsSetup',
      'Finish setup to link your GitHub account, then pick people here.'
    )
    const exactOnly = t(
      'bots.github.whoCanAsk.exactOnly',
      'GitHub finds people by their exact username.'
    )
    const ownerIds = github ? gitHubLinkedAccounts(github).map((entry) => entry.userId) : []
    for (const org of orgs) {
      connectors.push({
        key: `github:${org.installationId}`,
        kind: 'github',
        title: titled(BOT_CONNECTOR_NAMES.github, org.accountLogin),
        workspace: null,
        listed: gitHubMembersOf(bot.members, org.installationId),
        stamp: { source: 'github', workspaceId: org.installationId },
        max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
        search: client
          ? (query) =>
              slackCall(
                () => gitHubUsersRead.request(hostReadClient(client), { query }),
                gitHubUsersRead.interpret
              )
          : null,
        checking: false,
        notYet,
        errorMessage: (code) => searchError(code, BOT_CONNECTOR_NAMES.github, hostName, t),
        searchPlaceholder: t('bots.github.whoCanAsk.search', 'Search by GitHub username'),
        peopleHeading: t('bots.github.whoCanAsk.found', 'People on GitHub'),
        noMatch: (query) => ({
          title: t('bots.github.whoCanAsk.noUser', 'No GitHub user named “{{query}}”', { query }),
          detail: exactOnly
        }),
        idleHint: {
          title: t('bots.github.whoCanAsk.typeUsername', 'Type a GitHub username'),
          detail: exactOnly
        },
        ownerIds,
        takes: TAKES_NONE
      })
    }
    const people = botMembersFrom(bot.members, 'github')
    if (orgs.length === 0) {
      connectors.push({
        ...unreachable('github', BOT_CONNECTOR_NAMES.github, people, notYet),
        checking: githubRead.checking
      })
    }
  }
  // Someone no list shows (their workspace or org left outside Orca) can still be removed.
  const shown = new Set(connectors.flatMap((connector) => connector.listed))
  for (const kind of ['slack', 'linear', 'github'] as const) {
    const left = botMembersFrom(bot.members, kind).filter((member) => !shown.has(member))
    if (left.length > 0) {
      const title = BOT_CONNECTOR_NAMES[kind]
      connectors.push({ ...unreachable(kind, title, left, ''), key: `${kind}:other` })
    }
  }
  return connectors
}

/** A connector whose people can be seen and removed, but not added to yet. */
function unreachable(
  kind: BotAccessConnector,
  title: string,
  listed: BotMember[],
  notYet: string
): WhoCanAskConnector {
  return {
    key: kind,
    kind,
    title,
    workspace: null,
    listed,
    stamp: { source: kind },
    max: 0,
    search: null,
    checking: false,
    notYet,
    errorMessage: () => '',
    searchPlaceholder: '',
    peopleHeading: '',
    noMatch: () => ({ title: '', detail: '' }),
    ownerIds: [],
    takes: TAKES_NONE
  }
}
