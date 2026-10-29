import type { z } from 'zod'
import { agentHookServer } from '../../../../agent-hooks/server'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import {
  isPotentialQuestionAnsweredSubmitInput,
  isQuestionAnsweredSubmitInput,
  type AgentQuestionAnsweredInferenceRequest
} from '../../../../../shared/agent-question-answered-intent'

/** Snapshot before the write so a hook racing the answer wins over inference, as on desktop. */
function captureQuestionAnsweredBaseline(
  input: string,
  getPaneKey: () => string | null
): AgentQuestionAnsweredInferenceRequest | null {
  // Reject ordinary input before resolving the pane or parsing prompt JSON.
  if (!isPotentialQuestionAnsweredSubmitInput(input)) {
    return null
  }
  const paneKey = getPaneKey()
  if (!paneKey) {
    return null
  }
  const [row] = agentHookServer.getStatusSnapshotForPane(paneKey)
  if (!row || !isQuestionAnsweredSubmitInput(input, row.interactivePrompt)) {
    return null
  }
  return {
    paneKey,
    baselineUpdatedAt: row.receivedAt,
    baselineStateStartedAt: row.stateStartedAt,
    baselinePrompt: row.prompt,
    baselineAgentType: row.agentType
  }
}

/** Claude sends no hook once a question is answered, so an accepted send of its submit key clears the wait. */
export function observeQuestionAnswerSend(
  params: z.infer<typeof TerminalSend>,
  runtime: Pick<OrcaRuntimeService, 'getLiveTerminalPaneKey'>
): <T extends { accepted?: boolean }>(result: T) => T {
  // Desktop renderers infer answers from their own input; other writers rely on the host.
  const baseline =
    params.inputKind === 'query-reply' ||
    params.interrupt === true ||
    params.client?.type === 'desktop'
      ? null
      : captureQuestionAnsweredBaseline(
          `${params.text ?? ''}${params.enter === true ? '\r' : ''}`,
          () => runtime.getLiveTerminalPaneKey(params.terminal)
        )
  return (result) => {
    if (baseline && result.accepted === true) {
      agentHookServer.inferQuestionAnswered(baseline)
    }
    return result
  }
}
