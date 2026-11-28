// `orca bot connectors`, `orca bot reply --react` and `--leave-thread` on the stand-in host: each service's row read
// from the scenario (is gh signed in, does `orca linear` have a key), as bots-connectors.ts builds it.
import { botConnectorServices, type BotConnectorsView } from '../../shared/bots/bot-connectors-view'
import type { EvalHostState } from './bot-automation-eval-host'
import { workspaces } from './bot-automation-eval-connector'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'
import { LEAVE_THREAD_REFUSALS } from '../../shared/connectors/connector-leave-thread-copy'
import { RuntimeClientError } from '../runtime/connection/types'

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
        services: botConnectorServices(bot, {
          gh: state.github?.signedOut ? 'signed-out' : 'signed-in',
          linear: !state.linearSignedOut
        }),
        workspaces: workspaces(state)
      }
      return view
    }
    case 'connector.react':
      io.record({ kind: 'write', method, params })
      return { ok: true }
    case 'connector.leaveThread': {
      io.record({ kind: 'write', method, params })
      // As the host checks it: only a Slack channel thread can be left, never a DM or the owner's Chat.
      const conversation = state.conversation
      const refusal =
        conversation?.source !== 'slack' || conversation.slack?.channel.startsWith('D')
          ? 'not_a_thread'
          : state.leaveRefusal
      if (refusal) {
        throw new RuntimeClientError(refusal, LEAVE_THREAD_REFUSALS[refusal])
      }
      if (state.leftThread) {
        return { ok: true, already: true }
      }
      io.save({ ...state, leftThread: true })
      return { ok: true }
    }
  }
  return undefined
}
