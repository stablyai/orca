// The desktop's Request access wording, from the shared table, for the phone's bot sheet.
import type { BotAccessHost } from '../../../src/shared/bots/bot-access-copy'
import {
  accessRequestIdentity,
  accessRequestPerson
} from '../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { botAccessGrantFacts } from '../../../src/shared/bots/bot-access-grant'
import { CONNECTOR_SOURCE_NAMES } from '../../../src/shared/connectors/external-conversation-link'
import type { HostStatusReply } from '../transport/hosts/host-status-reply-schema'
import { normalizeMachineName } from '../../../src/shared/remote-runtime/host-metadata/machine-name'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import {
  botAccessConfirm,
  botAccessReach,
  botReachLineText,
  botStartingPermission,
  type BotAccessConfirmRow,
  type BotAccessConnector
} from '../../../src/shared/bots/bot-access-reach'
import type { Translate } from '../i18n/mobile-i18n'
import {
  mobileBotAccessCopy,
  mobileBotAccessNames,
  mobileBotAccessPlace
} from './mobile-bot-access-copy'
import { mobilePermissionModeCopy } from './mobile-permission-mode-copy'

/** What the phone knows of a bot's access. */
export type PhoneAccessBot = {
  name: string
  accessHost?: BotAccessHost
  agent: string
  permissionMode?: AgentChatPermissionMode
  google?: boolean
}

export function phoneAccessHost(status: HostStatusReply | undefined): BotAccessHost {
  return {
    kind: 'unknown',
    name: normalizeMachineName(status?.machineName) || null
  }
}

export function phoneBotReachLines(
  bot: PhoneAccessBot,
  t: Translate
): { title: string; detail?: string }[] {
  const permission = botStartingPermission(bot, null)
  return botAccessReach({
    agent: bot.agent,
    permission,
    connector: null,
    google: bot.google === true ? null : []
  }).map((line) =>
    botReachLineText(line, {
      name: bot.name,
      agentLabel: isTuiAgent(bot.agent) ? TUI_AGENT_DISPLAY_NAMES[bot.agent] : bot.agent,
      place: mobileBotAccessPlace(t, bot.accessHost ?? { kind: 'unknown', name: null }),
      mode: (mode) => mobilePermissionModeCopy(bot.agent, mode, t),
      copy: (id, values) => mobileBotAccessCopy(t, id, values)
    })
  )
}

function accessPlace(connector: string, workspace: string | null, t: Translate): string {
  return workspace ? mobileBotAccessCopy(t, 'place', { connector, workspace }) : connector
}

/** Who the connector says they are, without a real name that only repeats their name. */
function uniqueRequestIdentity(request: ConnectorAccessRequest): string {
  const { requester } = request
  const unique =
    requester.detail === accessRequestPerson(request) ? { ...requester, detail: '' } : requester
  return accessRequestIdentity({ ...request, requester: unique })
}

/** Under the person's name: who the connector says they are, and where they asked. */
export function accessRequestLine(request: ConnectorAccessRequest, t: Translate): string {
  return [
    uniqueRequestIdentity(request),
    accessPlace(CONNECTOR_SOURCE_NAMES[request.source], request.workspaceName || null, t)
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One fact row of the access decision, as the desktop's confirm lists it; `warn` rows read red. */
export type AccessDecisionRow = {
  kind: BotAccessConfirmRow['kind']
  text: string
  warn?: true
  connector?: BotAccessConnector
}

/** Who would get access, from where: a request's asker, or the people picked to add. */
export type PhoneAccessGrant = {
  /** identity: who the connector says they are, when asked from a request. */
  people: readonly { id: string; name: string; identity?: string }[]
  connector: BotAccessConnector
  workspace: string | null
}

export function accessRequestGrant(request: ConnectorAccessRequest): PhoneAccessGrant {
  return {
    people: [
      {
        id: request.requester.id,
        name: accessRequestPerson(request),
        identity: uniqueRequestIdentity(request)
      }
    ],
    connector: request.source,
    workspace: request.workspaceName || null
  }
}

/** The desktop's "Give access" confirm: its title, who and where, the warning line in its tone, and
 *  what they reach, one line each. The bot runs on the computer, not this phone. */
export function accessDecisionCopy(
  grant: PhoneAccessGrant,
  bot: PhoneAccessBot,
  t: Translate
): {
  title: string
  /** The heading over the rows: what the one person can do, or what they all can. */
  whatTheyCanDo: string
  who: string
  warning: string
  tone: 'high' | 'medium'
  rows: AccessDecisionRow[]
} {
  const connector = CONNECTOR_SOURCE_NAMES[grant.connector]
  const { person, firstName, names, count, identity } = botAccessGrantFacts({
    botName: bot.name,
    people: grant.people,
    connector,
    workspace: grant.workspace
  })
  // Without a handle, the full name, since the title shows only the first.
  const who = person
    ? identity || (person !== firstName ? person : '')
    : mobileBotAccessNames(names)
  const { tone, rows } = botAccessConfirm({
    permission: botStartingPermission(bot, null),
    connector: grant.connector,
    // Unknown counts, as on the desktop: the phone can't read which Google areas are on.
    google: bot.google === true
  })
  return {
    title: firstName
      ? mobileBotAccessCopy(t, 'titleOne', { person: firstName, name: bot.name })
      : mobileBotAccessCopy(t, 'titleMany', { count, name: bot.name }),
    // Its own line for several people: "they" inside the one-person line doesn't translate.
    whatTheyCanDo: firstName
      ? mobileBotAccessCopy(t, 'whatTheyCanDo', { person: firstName })
      : t('bots.accessDecide.whatTheyCanDoMany', 'What they can do'),
    who: [who, accessPlace(connector, grant.workspace, t)].filter(Boolean).join(' · '),
    warning: mobileBotAccessCopy(
      t,
      'confirmWarning',
      mobileBotAccessPlace(t, bot.accessHost ?? { kind: 'unknown', name: null })
    ),
    tone,
    rows: rows.map((row): AccessDecisionRow => {
      switch (row.kind) {
        case 'computer':
          return { kind: row.kind, text: mobileBotAccessCopy(t, 'confirmComputer') }
        case 'no-approvals':
          return { kind: row.kind, text: mobileBotAccessCopy(t, 'confirmNoApprovals'), warn: true }
        case 'may-skip-approvals':
          return {
            kind: row.kind,
            text: mobileBotAccessCopy(t, 'confirmMaySkipApprovals'),
            warn: true
          }
        case 'approves':
          return {
            kind: row.kind,
            text: firstName
              ? mobileBotAccessCopy(t, 'confirmApproveOne', { person: firstName })
              : mobileBotAccessCopy(t, 'confirmApproveMany')
          }
        case 'google':
          return { kind: row.kind, text: mobileBotAccessCopy(t, 'confirmGoogle') }
        case 'connector':
          return {
            kind: row.kind,
            connector: row.connector,
            text:
              row.connector === 'slack'
                ? mobileBotAccessCopy(t, 'reachSlack', { name: bot.name })
                : row.connector === 'github'
                  ? mobileBotAccessCopy(t, 'confirmGitHub')
                  : mobileBotAccessCopy(t, 'confirmLinear')
          }
      }
    })
  }
}

/** A request answered elsewhere or gone by when the phone asks about it. */
export const accessRequestExpiredLine = (t: Translate): string =>
  t('bots.accessDecide.expired', 'This request was already answered or has expired.')

/** Why the host didn't save an answer. */
export function accessDecideFailureLine(
  request: ConnectorAccessRequest,
  error: string,
  t: Translate
): string {
  switch (error) {
    case 'expired':
      return accessRequestExpiredLine(t)
    case 'full':
      return mobileBotAccessCopy(t, 'full', { person: accessRequestPerson(request) })
    case 'granted_not_added':
      return t(
        'bots.accessDecide.grantedNotAdded',
        'Access was given, but {{person}} isn’t listed yet. Orca will add them.',
        { person: accessRequestPerson(request) }
      )
    case 'signed_out':
      return t(
        'bots.accessDecide.signedOut',
        'Sign in to Orca on your computer to answer requests.'
      )
    default:
      return mobileBotAccessCopy(t, 'decideFailed')
  }
}
