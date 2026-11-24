// A place is the bot home a connector start runs in; its id names the bot with no lookup.
import { z } from 'zod'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorBot,
  type ConnectorCloudFeature,
  type ConnectorBotWorkspace
} from '../../shared/connectors/connector-cloud-contract'
import {
  botLinearWorkspaces,
  botMembersFrom,
  botSlackApps,
  gitHubMembersOf,
  linearMembersOf,
  slackMembersOf,
  type Bot,
  type BotMember
} from '../../shared/bot-types'
import { GITHUB_ID_PATTERN } from '../../shared/connector-bot-github-contract'
import type { ExternalConversationBot } from '../../shared/connectors/external-conversation-link'
import { BOT_MAX_SHARES, type BotShare } from '../../shared/bots/bot-team-shares'
import {
  ConnectorBotShareSchema,
  type ConnectorBotShare
} from '../../shared/connector-share-contract'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

const Place = z.tuple([z.enum(['bot', 'bot-chat']), z.string().min(1)])
type Place = z.infer<typeof Place>

export type ConnectorPlacesStore = Pick<RuntimeStore, 'getBots'>

function decodePlace(placeId: string): Place | null {
  try {
    const parsed = Place.safeParse(JSON.parse(Buffer.from(placeId, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The bot home a start's place names; null for any other place. */
export function placeLaunchTarget(placeId: string): ExternalConversationBot | null {
  const place = decodePlace(placeId)
  return place ? { kind: place[0], botId: place[1] } : null
}

// Ids JSON writes byte for byte, so the bots' share of a hello stays within its cap.
const PLAIN_ID = /^[\w.:-]+$/

// Room a hello keeps for everything but its bots and triggers (capabilities, host name…).
const HELLO_ENVELOPE_RESERVE_BYTES = 8 * 1024
// Room kept for triggers: maxHelloTriggers rules with every field at its cap, in plain text, fit in it.
const HELLO_TRIGGERS_RESERVE_BYTES = 256 * 1024
/** Each bot's share of a hello or bot page, so maxHelloBots of them fit beside the rest. */
export const BOT_HELLO_BUDGET_BYTES = Math.floor(
  (CONNECTOR_CLIENT_LIMITS.maxRequestBytes -
    HELLO_ENVELOPE_RESERVE_BYTES -
    HELLO_TRIGGERS_RESERVE_BYTES) /
    CONNECTOR_CLIENT_LIMITS.maxHelloBots
)

// Each as the contract reads it, at most its maxBotShares, so one bad record never voids the hello.
// Absent when there are none, which the cloud reads as not shared.
function sharedWith(shares: readonly BotShare[] | undefined): { sharedWith?: ConnectorBotShare[] } {
  const people = (shares ?? [])
    .map((share) =>
      share.kind === 'account'
        ? { shareId: share.shareId, accountId: share.accountId }
        : { shareId: share.shareId, email: share.email }
    )
    .filter((share) => ConnectorBotShareSchema.safeParse(share).success)
    .slice(0, BOT_MAX_SHARES)
  return people.length > 0 ? { sharedWith: people } : {}
}

/** A bot's GitHub people go on each installation, so a bot over its share drops installations from the end. */
function withinBotBudget(bot: ConnectorBot): ConnectorBot {
  const workspaces = [...(bot.sharedAppWorkspaces ?? [])]
  while (
    workspaces.at(-1)?.source === 'github' &&
    Buffer.byteLength(JSON.stringify({ ...bot, sharedAppWorkspaces: workspaces })) >
      BOT_HELLO_BUDGET_BYTES
  ) {
    workspaces.pop()
  }
  return { ...bot, sharedAppWorkspaces: workspaces }
}

/**
 * The bots on this machine as a hello lists them, cut to the contract's caps so one never voids the hello.
 * A bot on GitHub is there in each of the account's installations but those its owner removed.
 * Slack rows carry Who can ask per workspace; an older cloud keeps them unread and uses `members`.
 */
export function connectorBots(
  store: ConnectorPlacesStore,
  botsEnabled = true,
  gitHubInstallationIds: readonly string[] = [],
  /** What the cloud's last hello answer listed; null before one. */
  cloudFeatures: ReadonlySet<string> | null = null
): ConnectorBot[] {
  const {
    maxHelloBots,
    maxBotPages,
    maxBotIdLength,
    maxBotMembers,
    maxBotMemberIdLength,
    maxBotWorkspaceMemberIdLength,
    maxBotWorkspaceMembers,
    maxBotHandleLength,
    maxBotWorkspaces,
    maxBotSlackWorkspaces
  } = CONNECTOR_CLIENT_LIMITS
  // A cloud with `slack.teams` reads Slack rows beside the others, each as large as the Slack list.
  // Before the first answer they keep an older cloud's caps, so the hello always lands. A cloud
  // that answered without it never reads them, so it gets none.
  const slackTeams = cloudFeatures?.has('slack.teams' satisfies ConnectorCloudFeature) === true
  const sendSlack = cloudFeatures === null || slackTeams
  const plain = (id: string, max: number): boolean => id.length <= max && PLAIN_ID.test(id)
  const memberIds = (members: BotMember[], maxLength: number, maxCount: number): string[] =>
    members
      .map((member) => member.id)
      .filter((id) => plain(id, maxLength))
      .slice(0, maxCount)
  // GitHub ids are numbers, so they never grow a hello past the digits counted here.
  const gitHubWorkspaces = (
    members: readonly BotMember[],
    installationIds: readonly string[]
  ): ConnectorBotWorkspace[] => {
    const people = (installationId: string): string[] =>
      gitHubMembersOf(members, installationId)
        .map((member) => member.id)
        .filter((id) => GITHUB_ID_PATTERN.test(id))
        .slice(0, maxBotWorkspaceMembers)
    return installationIds
      .filter((id) => GITHUB_ID_PATTERN.test(id))
      .map((workspaceId) => ({
        source: 'github' as const,
        workspaceId,
        members: people(workspaceId)
      }))
  }
  // First and never dropped: a cloud with rows reads a workspace without one as the owner's alone.
  const slackWorkspaces = (bot: Bot): ConnectorBotWorkspace[] => {
    if (!sendSlack) {
      return []
    }
    const cap = slackTeams ? maxBotMembers : maxBotWorkspaceMembers
    return botSlackApps(bot)
      .filter((app) => plain(app.teamId, maxBotIdLength))
      .slice(0, slackTeams ? maxBotSlackWorkspaces : maxBotWorkspaces)
      .map((app) => {
        const people = memberIds(
          slackMembersOf(bot, app.teamId),
          maxBotWorkspaceMemberIdLength,
          Number.POSITIVE_INFINITY
        )
        if (people.length > cap) {
          console.warn(
            `[connector] Slack Who can ask for one workspace was cut to ${cap} until the cloud answers`
          )
        }
        return { source: 'slack' as const, workspaceId: app.teamId, members: people.slice(0, cap) }
      })
  }
  // An older cloud counts every row against one cap; a cloud with `slack.teams` counts Slack apart.
  const withSlackFirst = (
    slack: ConnectorBotWorkspace[],
    others: ConnectorBotWorkspace[]
  ): ConnectorBotWorkspace[] =>
    slackTeams
      ? [...slack, ...others.slice(0, maxBotWorkspaces)]
      : [...slack, ...others].slice(0, maxBotWorkspaces)
  // Every bot a cloud's pages take; the hello picks an older cloud's first maxHelloBots.
  return (store.getBots?.() ?? [])
    .filter((bot) => plain(bot.id, maxBotIdLength))
    .slice(0, maxHelloBots * maxBotPages)
    .map((bot) => ({
      id: bot.id,
      name: displayText(bot.name),
      agent: bot.agent,
      // The cloud reads these as Slack user ids; another source's people go in their workspace below.
      members: memberIds(botMembersFrom(bot.members, 'slack'), maxBotMemberIdLength, maxBotMembers),
      // Bots off reads as every bot paused: the cloud keeps the bot, so a running turn's Stop still arrives.
      paused: bot.paused || !botsEnabled,
      ...(plain(bot.folder, maxBotHandleLength) ? { handle: bot.folder } : {}),
      sharedAppWorkspaces: withSlackFirst(slackWorkspaces(bot), [
        ...botLinearWorkspaces(bot)
          .filter((linear) => plain(linear.workspaceId, maxBotIdLength))
          .map((linear) => ({
            source: 'linear' as const,
            workspaceId: linear.workspaceId,
            members: memberIds(
              linearMembersOf(bot.members, linear.workspaceId),
              maxBotWorkspaceMemberIdLength,
              maxBotWorkspaceMembers
            )
          })),
        ...(bot.github
          ? gitHubWorkspaces(
              bot.members,
              gitHubInstallationIds.filter(
                (id) => !bot.github?.removedInstallationIds?.includes(id)
              )
            )
          : [])
      ]),
      ...sharedWith(bot.shares)
    }))
    .map(withinBotBudget)
}

/** At most the contract's display length, never splitting a surrogate pair. */
export function displayText(text: string): string {
  const max = CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}
