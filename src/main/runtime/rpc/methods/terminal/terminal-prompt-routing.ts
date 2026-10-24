import type { z } from 'zod'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RuntimeAgentPromptWriteOptions } from '../../../runtime-terminal-contracts'

type TerminalPromptRoute = Pick<RuntimeAgentPromptWriteOptions, 'beforeWrite' | 'expectedBinding'>

export async function prepareTerminalSendPrompt(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof TerminalSend>,
  durable: boolean,
  beforeWrite: RuntimeAgentPromptWriteOptions['beforeWrite']
): Promise<TerminalPromptRoute | null> {
  if (
    params.agentPrompt !== true ||
    !params.text ||
    params.enter !== true ||
    params.interrupt === true ||
    params.client?.type !== 'desktop'
  ) {
    return null
  }
  if (await runtime.isTerminalRunningSettledPromptAgent(params.terminal)) {
    return { beforeWrite }
  }
  const pi = durable ? await runtime.preparePiTerminalPrompt(params.terminal, params.text) : null
  if (!pi) {
    return null
  }
  return {
    expectedBinding: pi.expectedBinding,
    beforeWrite: async (ptyId) => {
      await beforeWrite?.(ptyId)
      await pi.beforeWrite?.(ptyId)
    }
  }
}
