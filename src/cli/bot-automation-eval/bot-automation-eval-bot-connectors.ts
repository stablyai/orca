// `orca bot connectors` and `orca bot reply --react` on the stand-in host: each service's row read
// from the scenario (is gh signed in, does `orca linear` have a key), as bots-connectors.ts builds it.
import { botConnectorServices, type BotConnectorsView } from '../../shared/bots/bot-connectors-view'
import type { EvalHostState } from './bot-automation-eval-host'
import { capabilities, workspaces } from './bot-automation-eval-connector'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'

export function serveBotConnectors(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  switch (method) {
    case 'bots.connectors': {
      const bot = state.bots[0]!
      const view: BotConnectorsView = {
        bot: bot.name,
        services: botConnectorServices(
          bot,
          {
            gh: state.github?.signedOut ? 'signed-out' : 'signed-in',
            linear: !state.linearSignedOut
          },
          capabilities(state)
        ),
        workspaces: workspaces(state)
      }
      return view
    }
    case 'connector.react':
      io.record({ kind: 'write', method, params })
      return { ok: true }
  }
  return undefined
}
