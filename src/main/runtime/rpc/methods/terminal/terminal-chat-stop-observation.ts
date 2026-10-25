import type { z } from 'zod'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { WriteSettlementSink } from '../../../../../shared/chat-stop-input'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RuntimeTerminalWriteOptions } from '../../../runtime-terminal-writer'

export function chatStopWriteObservation(
  runtime: OrcaRuntimeService,
  params: z.output<typeof TerminalSend>,
  reserveWrite: RuntimeTerminalWriteOptions['reserveWrite']
): Pick<RuntimeTerminalWriteOptions, 'reserveWrite' | 'onSettlement'> {
  const input = params.chatStop
  if (
    !input ||
    params.text !== '\x1b' ||
    params.enter === true ||
    params.interrupt === true ||
    params.inputKind === 'query-reply' ||
    params.agentPrompt ||
    params.resolvedLaunchDraft ||
    params.requireAgentStatus ||
    params.requireWriteSettlement
  ) {
    return reserveWrite ? { reserveWrite } : {}
  }
  let sink: WriteSettlementSink | undefined
  return {
    reserveWrite: (ptyId) => {
      reserveWrite?.(ptyId)
      sink = runtime.captureChatStopInput(ptyId, input)
    },
    onSettlement: (result) => sink?.(result)
  }
}
