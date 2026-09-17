import type { z } from 'zod'
import { InvalidArgumentError } from '../../core'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import type { TerminalSend } from './unary-schemas'

// Why: a query reply is a mobile-only, bare-text answer to a terminal prompt; any other shape on
// that input kind is a malformed client request, not a guard outcome.
export function assertTerminalQueryReplyParams(
  params: z.infer<typeof TerminalSend>,
  clientId: string | undefined,
  queryReplyClientId: string | undefined
): void {
  if (params.inputKind !== 'query-reply') {
    return
  }
  if (
    !params.text ||
    !isTerminalQueryReply(params.text) ||
    params.enter === true ||
    params.interrupt === true ||
    params.agentPrompt === true ||
    params.requireAgentStatus !== undefined ||
    params.client?.type !== 'mobile' ||
    !queryReplyClientId ||
    (clientId !== undefined && params.client.id !== clientId)
  ) {
    throw new InvalidArgumentError('Invalid terminal query reply')
  }
}
