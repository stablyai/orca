import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CursorStructuredOwner } from './cursor-structured-owner'
import type { CursorStructuredSessionAdapterDeps } from './cursor-structured-session-adapter'
import { CursorAcpRequestError } from './cursor-acp-connection'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import {
  cursorAcpPromptContent,
  cursorPromptContentRejection,
  cursorDispatchRejection
} from './cursor-acp-prompt-content'

export async function dispatchCursorStructuredMessage(
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  ownerFor: (sessionId: string, fence: number) => CursorStructuredOwner,
  accept: (sessionId: string, owner: CursorStructuredOwner) => void,
  reportExit: (sessionId: string, owner: CursorStructuredOwner, error: Error) => void,
  settle: CursorStructuredSessionAdapterDeps['onDispatchSettledLate']
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  const owner = ownerFor(input.sessionId, input.fence)
  let prompt: Record<string, unknown>[]
  try {
    prompt = await cursorAcpPromptContent(input.body, owner.connection?.capabilities ?? {})
  } catch (error) {
    return { state: 'rejected', ...cursorPromptContentRejection(error) }
  }
  await input.beforeDispatch?.()
  if (ownerFor(input.sessionId, input.fence) !== owner) {
    throw new Error('Cursor owner changed during prompt preparation')
  }
  if (!owner.session || owner.session.phase !== 'ready' || owner.connection?.closed) {
    throw new Error('Cursor ACP turn is already running')
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
      if (error instanceof CursorAcpRequestError && owner.pending) {
        const clientMessageId = owner.pending.clientMessageId
        owner.pending = null
        settle({
          sessionId: input.sessionId,
          clientMessageId,
          state: 'rejected',
          ...cursorDispatchRejection(
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
