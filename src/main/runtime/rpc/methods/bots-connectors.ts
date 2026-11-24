// `orca bot connectors`: what a bot can use where, read live on this computer and from Orca Cloud.
import { z } from 'zod'
import {
  botConnectorServices,
  type BotConnectorsView
} from '../../../../shared/bots/bot-connectors-view'
import { BotConnectors } from '../../../../shared/rpc-contract/bots-look-around-params'
import { readGhSignIn } from '../../../bots/bot-local-sign-ins'
import { getGoogleConnect } from '../../../google/google-connect'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { defineMethod, InvalidArgumentError } from '../core'
import { CONNECTOR_ACT_METHOD } from './connector-act'

type Workspaces = Pick<BotConnectorsView, 'workspaces' | 'workspacesNote'>

const RefView = z.object({ ref: z.string(), label: z.string() })
const Workspace = RefView.extend({ source: z.string(), places: z.array(RefView).optional() })
// One workspace this build can't read drops only that one.
const PlacesResult = z.object({
  workspaces: z
    .array(z.unknown())
    .transform((entries) => entries.flatMap((entry) => Workspace.safeParse(entry).data ?? []))
})
const CapabilitiesResult = z.object({
  sources: z.array(z.object({ source: z.string(), approveUrl: z.string().optional() }))
})

export const BOT_CONNECTORS_METHOD = defineMethod({
  name: 'bots.connectors',
  permission: 'workspace',
  params: BotConnectors,
  handler: async ({ callerSessionId }, context): Promise<BotConnectorsView> => {
    const { runtime, pairedDeviceId } = context
    runtime.bots.assertEnabled()
    // A session id names a chat only on its own host.
    const bot = pairedDeviceId === undefined ? botOfSession(runtime.bots, callerSessionId) : null
    if (!bot) {
      throw new InvalidArgumentError("Run this from a bot's chat.")
    }
    // The cloud's own words when it can't answer: signed out, not connected yet, or an older cloud.
    const act = (verb: 'capabilities' | 'places') =>
      CONNECTOR_ACT_METHOD.handler({ sessionId: callerSessionId, verb, args: {} }, context)
    const [gh, capabilities, places] = await Promise.all([
      readGhSignIn(),
      act('capabilities').catch(() => null),
      act('places').catch((error: unknown) => (error instanceof Error ? error : null))
    ])
    const sources = capabilities?.ok
      ? CapabilitiesResult.safeParse(capabilities.result).data?.sources
      : undefined
    const listed =
      places && !(places instanceof Error) && places.ok
        ? PlacesResult.safeParse(places.result).data
        : undefined
    const workspaces: Workspaces = listed
      ? { workspaces: listed.workspaces }
      : {
          workspaces: [],
          workspacesNote:
            places instanceof Error
              ? places.message
              : places && !places.ok
                ? places.message
                : 'Orca Cloud could not list them.'
        }
    return {
      bot: bot.name,
      services: botConnectorServices(
        bot,
        {
          gh,
          linear: (await runtime.linearStatus()).connected,
          google: (await getGoogleConnect()?.accounts()) ?? [],
          googleApp: Boolean(await getGoogleConnect()?.client()),
          googleDefault: (await getGoogleConnect()?.defaultAccount()) ?? null
        },
        sources
      ),
      ...workspaces
    }
  }
})
