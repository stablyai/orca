// What one chat's session answers to the zcode app-server's own requests, from its launch until it closes.
import type { ZcodeRuntimeHeadersAsks } from './zcode-runtime-headers-ask'
import type { ZcodeStructuredSession } from './zcode-structured-session'
import { zcodeReadOnlyAnswer } from '../prompts/zcode-structured-read-only'

/** Routes one server→client request and answers bookkeeping asks directly. */
export function answerZcodeServerRequest(
  session: ZcodeStructuredSession,
  headersAsks: ZcodeRuntimeHeadersAsks,
  method: string,
  params: unknown,
  id: number | string
): void {
  const { connection, deps, options, prompts } = session
  if (method === 'session/requestRuntimePreferences') {
    connection.respond(id, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    })
    return
  }
  if (method === 'interaction/requestProviderRuntimeHeaders') {
    headersAsks.answer({
      connection,
      params,
      id,
      credentials: deps.credentials,
      options,
      lane: session.lane,
      providerSessionId: session.providerSessionId,
      now: deps.now
    })
    return
  }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') {
    connection.respondWithError(id, -32000, 'official MCP auth is unavailable in Orca chats')
    return
  }
  // A read-only session asks nobody: nobody watches it to answer, and it may do nothing that needs asking.
  const refusal = deps.launch.readOnly ? zcodeReadOnlyAnswer(method, deps.launch.readOnly) : null
  if (refusal) {
    connection.respond(id, refusal)
    return
  }
  if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
    // handle can throw synchronously (unsupported shape); deferring keeps that throw inside
    // the promise so the provider still receives the error reply.
    void Promise.resolve()
      .then(() => prompts.handle(method, params, id))
      .catch((error: unknown) => {
        deps.logger?.warn('zcode interaction could not be answered', {
          scope: 'zcode-interaction',
          method,
          error
        })
        connection.respondWithError(id, -32603, String(error))
      })
    return
  }
  deps.logger?.warn('zcode app-server sent an unknown request', {
    scope: 'zcode-request-unknown',
    method
  })
  connection.respondWithError(id, -32601, `Orca does not answer ${method}`)
}
