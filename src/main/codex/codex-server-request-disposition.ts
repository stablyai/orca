import type {
  CodexAppServerConnection,
  CodexAppServerServerRequest
} from './codex-app-server-connection'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  type CodexPromptRegistry,
  type CodexPendingPrompt
} from './codex-structured-prompt-replies'

export const CODEX_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request'
export const CODEX_PERMISSIONS_APPROVAL_METHOD = 'item/permissions/requestApproval'
export const CODEX_DYNAMIC_TOOL_CALL_METHOD = 'item/tool/call'
export const CODEX_AUTH_TOKEN_REFRESH_METHOD = 'account/chatgptAuthTokens/refresh'
export const CODEX_ATTESTATION_METHOD = 'attestation/generate'
export const CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD = 'applyPatchApproval'
export const CODEX_LEGACY_EXEC_APPROVAL_METHOD = 'execCommandApproval'

export const CODEX_BLOCKING_SERVER_REQUEST_METHODS = [
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  CODEX_DYNAMIC_TOOL_CALL_METHOD,
  CODEX_AUTH_TOKEN_REFRESH_METHOD,
  CODEX_ATTESTATION_METHOD,
  CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD,
  CODEX_LEGACY_EXEC_APPROVAL_METHOD
] as const

export type CodexServerRequestDisposition =
  | { kind: 'prompt'; prompt: CodexPendingPrompt }
  | { kind: 'responded'; method: string }

type ResponseConnection = Pick<CodexAppServerConnection, 'respond' | 'respondWithError'>

/** Every app-server request either becomes a durable prompt or receives a safe reply. */
export function disposeCodexServerRequest(
  registry: CodexPromptRegistry,
  connection: ResponseConnection,
  request: CodexAppServerServerRequest
): CodexServerRequestDisposition {
  const prompt = registry.register(request)
  if (prompt) {
    return { kind: 'prompt', prompt }
  }

  switch (request.method) {
    case CODEX_COMMAND_APPROVAL_METHOD:
    case CODEX_FILE_CHANGE_APPROVAL_METHOD:
    case CODEX_USER_INPUT_METHOD:
      connection.respondWithError(
        request.id,
        -32001,
        `Orca could not model ${request.method} as a durable prompt`
      )
      break
    case CODEX_MCP_ELICITATION_METHOD:
      connection.respond(request.id, { action: 'decline', content: null, _meta: null })
      break
    case CODEX_PERMISSIONS_APPROVAL_METHOD:
      connection.respond(request.id, { permissions: {}, scope: 'turn', strictAutoReview: true })
      break
    case CODEX_DYNAMIC_TOOL_CALL_METHOD:
      connection.respond(request.id, { contentItems: [], success: false })
      break
    case CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD:
    case CODEX_LEGACY_EXEC_APPROVAL_METHOD:
      connection.respond(request.id, { decision: 'abort' })
      break
    case CODEX_AUTH_TOKEN_REFRESH_METHOD:
      connection.respondWithError(request.id, -32001, 'Orca cannot refresh app-server auth tokens')
      break
    case CODEX_ATTESTATION_METHOD:
      connection.respondWithError(request.id, -32001, 'Orca did not negotiate attestation')
      break
    default:
      connection.respondWithError(
        request.id,
        -32000,
        `Orca rejected unrecognized blocking request ${request.method}`
      )
  }
  return { kind: 'responded', method: request.method }
}
