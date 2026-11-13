// A client that lost a send's reply asks here instead of searching the history pages it loaded.

import { SendRecordedParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-send-recorded-params'
import type { StructuredSendAnswer } from '../../../../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

/** Recorded in any state, as a loaded row or card settles a send; a rejection stays in history, as a live reply's does. */
function sendRecorded(answer: StructuredSendAnswer): boolean {
  switch (answer.kind) {
    case 'waiting':
    case 'withdrawn':
    case 'accepted':
    case 'rejected':
    case 'unknown':
      return true
    case 'refused':
    case 'absent':
    case 'unreadable':
      return false
  }
}

export const STRUCTURED_AGENT_SESSION_SEND_RECORDED_METHODS = [
  defineMethod({
    name: 'agentSession.sendRecorded',
    permission: 'workspace',
    params: SendRecordedParams,
    handler: async (params, ctx): Promise<{ recorded: boolean }> => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return {
        recorded: sendRecorded(await host.sendAnswer(params.sessionId, params.clientMessageId))
      }
    }
  })
]
