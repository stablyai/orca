import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import { PeerGroupQuestion } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PeerMailMessageRow } from '../../db/federation/peer-mail-store'
import type { MessageRow } from '../../db/orchestration-records'
import { OrchestrationError } from '../../orchestration-error'

/** The pinned Home Chat must still be the receiving bot's active Home. */
export function peerGroupHome(runtime: OrcaRuntimeService, botId: string, sessionId?: string) {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  if (
    !bot ||
    bot.paused ||
    !bot.chatSessionId ||
    !isOrcaSessionId(bot.chatSessionId) ||
    (sessionId !== undefined && bot.chatSessionId !== sessionId)
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      'The group bot’s original Home Chat is no longer active.',
      { effectsApplied: false }
    )
  }
  return formatOrcaSessionAddress(bot.chatSessionId)
}

export function peerGroupQuestionRecipient(
  runtime: OrcaRuntimeService,
  original: MessageRow,
  route: PeerMailMessageRow
) {
  const db = runtime.getOrchestrationDb()
  const scope = PeerGroupQuestion.safeParse(JSON.parse(route.group_question ?? 'null')).data
  const request = db.getBotRequest(original.id)
  if (
    !scope ||
    request?.purpose !== 'question' ||
    request.to_bot_id !== scope.botId ||
    peerGroupHome(runtime, scope.botId) !== original.to_handle
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      'This mail is not a current group question for that Home Chat.',
      { effectsApplied: false }
    )
  }
  return original.to_handle
}
