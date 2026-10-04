import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { DshStructuredOwner } from './dsh-structured-owner'
import type { DshStructuredSessionAdapterDeps } from './dsh-structured-session-adapter'
import { DshAcpRequestError } from './dsh-acp-connection'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import {
  dshAcpPromptContent,
  dshPromptContentRejection,
  dshDispatchRejection
} from './dsh-acp-prompt-content'

export async function dispatchDshStructuredMessage(
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  ownerFor: (sessionId: string, fence: number) => DshStructuredOwner,
  accept: (sessionId: string, owner: DshStructuredOwner) => void,
  reportExit: (sessionId: string, owner: DshStructuredOwner, error: Error) => void,
  settle: DshStructuredSessionAdapterDeps['onDispatchSettledLate']
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  const owner = ownerFor(input.sessionId, input.fence)
  let prompt: Record<string, unknown>[]
  try {
    prompt = dshAcpPromptContent(input.body)
  } catch (error) {
    return { state: 'rejected', ...dshPromptContentRejection(error) }
  }
  await input.beforeDispatch?.()
  if (ownerFor(input.sessionId, input.fence) !== owner) {
    throw new Error('Dsh owner changed during prompt preparation')
  }
  if (!owner.session || owner.session.phase !== 'ready' || owner.connection?.closed) {
    throw new Error('Dsh ACP turn is already running')
  }
  const providerIdentity = owner.journal.begin(input.clientMessageId, input.requestedAt)
  owner.journal.append(providerIdentity, input.body)
  owner.pending = { clientMessageId: input.clientMessageId, providerIdentity }
  void owner.session
    .prompt(prompt)
    .then((reason) => {
      if (owner.stopped || owner.ended) {
        return
      }
      accept(input.sessionId, owner)
      owner.journal.end(reason)
      owner.prompts.clear()
    })
    .catch(async (error: unknown) => {
      if (error instanceof DshAcpRequestError && owner.pending) {
        const clientMessageId = owner.pending.clientMessageId
        owner.pending = null
        settle({
          sessionId: input.sessionId,
          clientMessageId,
          state: 'rejected',
          ...dshDispatchRejection(
            agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) })
          )
        })
      }
      if (await owner.connection?.close()) {
        reportExit(
          input.sessionId,
          owner,
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })
  return { state: 'admitted' }
}
