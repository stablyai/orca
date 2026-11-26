import { CommanderChatAskPreferenceParams } from '../../../../shared/rpc-contract/commander-chat'
import { askFromCommanderHome } from '../../../commander/commander-home-session'
import { defineMethod, InvalidArgumentError } from '../core'

export const COMMANDER_CHAT_ASK_PREFERENCE = defineMethod({
  name: 'commanderChat.askPreference',
  permission: 'workspace',
  params: CommanderChatAskPreferenceParams,
  handler: (params, context) => {
    if (
      context.caller?.kind !== 'local-cli' ||
      context.pairedDeviceId !== undefined ||
      context.clientKind !== undefined
    ) {
      throw new InvalidArgumentError('Run the preference lookup in your local Commander Home chat.')
    }
    return askFromCommanderHome(context.runtime, params)
  }
})
