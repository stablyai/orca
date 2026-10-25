import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  parseConversationReferenceUri,
  ConversationReferenceSchema,
  ConversationReferencePageSchema,
  type ConversationReferenceCreate,
  type ConversationReferenceRead
} from '../../shared/conversation-reference'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'

export async function forwardConversationReference(
  method: 'conversation.createReference' | 'conversation.read',
  request: ConversationReferenceCreate | ConversationReferenceRead
): Promise<unknown> {
  const hostId =
    'source' in request
      ? request.executionHostId
      : parseConversationReferenceUri(request.reference)?.hostId
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    throw new Error(
      'The referenced conversation is not available on this host. Reconnect its source host.'
    )
  }
  const response = await callRuntimeEnvironment(
    getAppEnvironment().getPath('userData'),
    host.environmentId,
    method,
    method === 'conversation.read' ? { ...request, localOnly: true } : request,
    60_000
  )
  if (!response.ok) {
    throw new Error(
      response.error.code === 'method_not_found'
        ? 'Update the source Orca host to use conversation references.'
        : response.error.message
    )
  }
  return method === 'conversation.read'
    ? ConversationReferencePageSchema.parse(response.result)
    : ConversationReferenceSchema.parse(response.result)
}
