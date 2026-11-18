// The desktop's Request access wording, from the shared table, for the phone's bot sheet.
import {
  botAccessPlace,
  botAccessCopy,
  type BotAccessHost
} from '../../../src/shared/bots/bot-access-copy'
import {
  accessRequestIdentity,
  accessRequestPerson
} from '../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { CONNECTOR_SOURCE_NAMES } from '../../../src/shared/connectors/external-conversation-link'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import { agentChatPermissionModeCopy } from '../../../src/shared/agent-session/options/permissions/structured-agent-session-permission-option'
import {
  botAccessReach,
  botReachLineText,
  botStartingPermission
} from '../../../src/shared/bots/bot-access-reach'

/** What the phone knows of a bot's access. */
export type PhoneAccessBot = {
  name: string
  accessHost?: BotAccessHost
  agent: string
  permissionMode?: AgentChatPermissionMode
  google?: boolean
}

/** The desktop's What it can reach list, from the shared model, as the phone words it: the computer
 *  is "your computer", and Google's services can't be read here. */
export function phoneBotReachLines(bot: PhoneAccessBot): { title: string; detail?: string }[] {
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
      place: botAccessPlace(bot.accessHost ?? { kind: 'owner-computer' }),
      mode: (mode) => agentChatPermissionModeCopy(bot.agent, mode)
    })
  )
}

function accessRequestPlace(request: ConnectorAccessRequest): string {
  const connector = CONNECTOR_SOURCE_NAMES[request.source]
  return request.workspaceName
    ? botAccessCopy('place', { connector, workspace: request.workspaceName })
    : connector
}

/** Under the person's name: who the connector says they are, and where they asked. */
export function accessRequestLine(request: ConnectorAccessRequest): string {
  const { requester } = request
  const unique =
    requester.detail === accessRequestPerson(request) ? { ...requester, detail: '' } : requester
  return [accessRequestIdentity({ ...request, requester: unique }), accessRequestPlace(request)]
    .filter(Boolean)
    .join(' · ')
}

/** The desktop's "Give access" confirm; the bot runs on the computer, not this phone. */
export function accessGrantConfirmCopy(
  request: ConnectorAccessRequest,
  bot: PhoneAccessBot
): { title: string; message: string } {
  const person = accessRequestPerson(request)
  const identity = accessRequestIdentity(request)
  const name = bot.name
  return {
    title: botAccessCopy('titleOne', { person, name }),
    message: [
      botAccessCopy('descriptionOne', {
        person,
        name,
        place: accessRequestPlace(request),
        ...botAccessPlace(bot.accessHost ?? { kind: 'owner-computer' })
      }),
      identity
        ? botAccessCopy('account', { connector: CONNECTOR_SOURCE_NAMES[request.source], identity })
        : null,
      // What the desktop's confirm lists: everything they reach through the bot.
      ...phoneBotReachLines(bot).map((line) =>
        line.detail ? `${line.title}. ${line.detail}` : `${line.title}.`
      ),
      botAccessCopy('yourAccess', {
        name,
        ...botAccessPlace(bot.accessHost ?? { kind: 'owner-computer' })
      }),
      botAccessCopy('removeAnyTime')
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}

/** Why the host didn't save an answer. */
export function accessDecideFailureLine(request: ConnectorAccessRequest, error: string): string {
  switch (error) {
    case 'expired':
      return 'This request was already answered or has expired.'
    case 'full':
      return botAccessCopy('full', { person: accessRequestPerson(request) })
    case 'granted_not_added':
      return `Access was given, but ${accessRequestPerson(request)} isn’t listed yet. Orca will add them.`
    case 'signed_out':
      return 'Sign in to Orca on your computer to answer requests.'
    default:
      return botAccessCopy('decideFailed')
  }
}
