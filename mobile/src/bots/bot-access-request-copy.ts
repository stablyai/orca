// The desktop's Request access wording, from the shared table, for the phone's bot sheet.
import type { BotAccessHost } from '../../../src/shared/bots/bot-access-copy'
import {
  accessRequestIdentity,
  accessRequestPerson
} from '../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { CONNECTOR_SOURCE_NAMES } from '../../../src/shared/connectors/external-conversation-link'
import type { HostStatusReply } from '../transport/hosts/host-status-reply-schema'
import { normalizeMachineName } from '../../../src/shared/remote-runtime/host-metadata/machine-name'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent-config'
import {
  botAccessReach,
  botReachLineText,
  botStartingPermission
} from '../../../src/shared/bots/bot-access-reach'
import {
  finalSentenceStop,
  joinSentences,
  sentenceStop
} from '../../../src/shared/text/sentence-joining'
import type { Translate } from '../i18n/mobile-i18n'
import { mobileBotAccessCopy, mobileBotAccessPlace } from './mobile-bot-access-copy'
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

function accessRequestPlace(request: ConnectorAccessRequest, t: Translate): string {
  const connector = CONNECTOR_SOURCE_NAMES[request.source]
  return request.workspaceName
    ? mobileBotAccessCopy(t, 'place', { connector, workspace: request.workspaceName })
    : connector
}

/** Under the person's name: who the connector says they are, and where they asked. */
export function accessRequestLine(request: ConnectorAccessRequest, t: Translate): string {
  const { requester } = request
  const unique =
    requester.detail === accessRequestPerson(request) ? { ...requester, detail: '' } : requester
  return [accessRequestIdentity({ ...request, requester: unique }), accessRequestPlace(request, t)]
    .filter(Boolean)
    .join(' · ')
}

/** The desktop's "Give access" confirm; the bot runs on the computer, not this phone. */
export function accessGrantConfirmCopy(
  request: ConnectorAccessRequest,
  bot: PhoneAccessBot,
  t: Translate
): { title: string; message: string } {
  const person = accessRequestPerson(request)
  const identity = accessRequestIdentity(request)
  const name = bot.name
  const place = mobileBotAccessPlace(t, bot.accessHost ?? { kind: 'unknown', name: null })
  return {
    title: mobileBotAccessCopy(t, 'titleOne', { person, name }),
    message: [
      mobileBotAccessCopy(t, 'descriptionOne', {
        person,
        name,
        place: accessRequestPlace(request, t),
        ...place
      }),
      identity
        ? mobileBotAccessCopy(t, 'account', {
            connector: CONNECTOR_SOURCE_NAMES[request.source],
            identity
          })
        : null,
      // What the desktop's confirm lists: everything they reach through the bot.
      ...phoneBotReachLines(bot, t).map((line) =>
        line.detail
          ? joinSentences([`${line.title}${sentenceStop(line.title)}`, line.detail])
          : `${line.title}${finalSentenceStop(line.title)}`
      ),
      mobileBotAccessCopy(t, 'yourAccess', { name, ...place }),
      mobileBotAccessCopy(t, 'removeAnyTime')
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}

/** Why the host didn't save an answer. */
export function accessDecideFailureLine(
  request: ConnectorAccessRequest,
  error: string,
  t: Translate
): string {
  switch (error) {
    case 'expired':
      return t('bots.accessDecide.expired', 'This request was already answered or has expired.')
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
