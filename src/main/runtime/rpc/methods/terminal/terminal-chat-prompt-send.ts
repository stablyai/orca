import type { z } from 'zod'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalInputSource } from '../../../terminal/input/terminal-input-admission'
import { InvalidArgumentError } from '../../core'

export function sendTerminalChatPrompt(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof TerminalSend>,
  inputSource: TerminalInputSource
) {
  if (
    !params.chatPrompt ||
    params.text !== undefined ||
    params.enter !== undefined ||
    params.interrupt !== undefined ||
    params.agentPrompt !== undefined ||
    params.inputSequence !== undefined ||
    params.inputKind !== undefined ||
    params.requireAgentStatus !== undefined ||
    params.resolvedLaunchDraft !== undefined ||
    params.claimViewport !== undefined ||
    params.client?.type !== 'desktop' ||
    inputSource !== 'desktop'
  ) {
    throw new InvalidArgumentError('invalid_terminal_send')
  }
  return runtime
    .sendTerminalChatPrompt(params.terminal, params.chatPrompt, params.expectedIncarnationId)
    .then((send) => ({ send }))
}
