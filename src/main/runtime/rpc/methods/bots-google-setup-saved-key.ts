// `bots.googleSetup.importHostKey`: the owner's Import file for an agent on this host, from another
// computer. The key its Orca browser saved here is imported here, or listed for the owner to pick;
// older clients never call it.
import { GoogleSetupImportHostKey } from '../../../../shared/rpc-contract/google-setup-params'
import { importGoogleSetupKeySavedHere } from '../../../google/google-setup-saved-key'
import { googleSetupRuns } from '../../../google/google-setup-runs'
import { isAgentRpcCaller } from '../callers/rpc-caller-identity'
import { defineMethod, InvalidArgumentError } from '../core'
import { answerGoogleSetupCard, whose, withBlocker } from './bots-google-setup'

export const GOOGLE_SETUP_SAVED_KEY_METHODS = [
  defineMethod({
    name: 'bots.googleSetup.importHostKey',
    permission: 'workspace',
    share: 'not-shared',
    params: GoogleSetupImportHostKey,
    handler: async ({ botId, file }, context) => {
      if (isAgentRpcCaller(context.caller)) {
        throw new InvalidArgumentError('Only your owner imports the key, in Orca.')
      }
      whose({ botId }, context)
      const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
      const imported = bot
        ? await importGoogleSetupKeySavedHere(
            bot,
            () =>
              answerGoogleSetupCard(context.runtime, botId, 'owner', 'step', ['done', 'client']),
            file
          )
        : { found: false as const, candidates: [] }
      return { ...imported, ...(await withBlocker(context, botId, googleSetupRuns().get(botId))) }
    }
  })
]
