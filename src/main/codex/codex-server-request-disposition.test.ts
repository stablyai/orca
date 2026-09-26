import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_ATTESTATION_METHOD,
  CODEX_AUTH_TOKEN_REFRESH_METHOD,
  CODEX_BLOCKING_SERVER_REQUEST_METHODS,
  CODEX_DYNAMIC_TOOL_CALL_METHOD,
  CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD,
  CODEX_LEGACY_EXEC_APPROVAL_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  disposeCodexServerRequest
} from './codex-server-request-disposition'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CodexPromptRegistry
} from './codex-structured-prompt-replies'

function harness() {
  return {
    registry: new CodexPromptRegistry(),
    connection: { respond: vi.fn(), respondWithError: vi.fn() }
  }
}

const promptParams = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' }

describe('Codex blocking server request dispositions', () => {
  it.each([
    CODEX_COMMAND_APPROVAL_METHOD,
    CODEX_FILE_CHANGE_APPROVAL_METHOD,
    CODEX_USER_INPUT_METHOD
  ])('routes %s to the durable prompt registry', (method) => {
    const { registry, connection } = harness()
    const result = disposeCodexServerRequest(registry, connection, {
      id: 1,
      method,
      params:
        method === CODEX_USER_INPUT_METHOD
          ? { ...promptParams, questions: [{ id: 'q1' }] }
          : promptParams
    })

    expect(result.kind).toBe('prompt')
    expect(connection.respond).not.toHaveBeenCalled()
    expect(connection.respondWithError).not.toHaveBeenCalled()
  })

  it.each([
    [CODEX_MCP_ELICITATION_METHOD, { action: 'decline', content: null, _meta: null }],
    [CODEX_PERMISSIONS_APPROVAL_METHOD, { permissions: {}, scope: 'turn', strictAutoReview: true }],
    [CODEX_DYNAMIC_TOOL_CALL_METHOD, { contentItems: [], success: false }],
    [CODEX_LEGACY_APPLY_PATCH_APPROVAL_METHOD, { decision: 'abort' }],
    [CODEX_LEGACY_EXEC_APPROVAL_METHOD, { decision: 'abort' }]
  ])('safely responds to %s', (method, response) => {
    const { registry, connection } = harness()

    expect(disposeCodexServerRequest(registry, connection, { id: 2, method, params: {} })).toEqual({
      kind: 'responded',
      method
    })
    expect(connection.respond).toHaveBeenCalledWith(2, response)
  })

  it.each([
    [CODEX_AUTH_TOKEN_REFRESH_METHOD, 'cannot refresh app-server auth tokens'],
    [CODEX_ATTESTATION_METHOD, 'did not negotiate attestation']
  ])('explicitly refuses %s', (method, message) => {
    const { registry, connection } = harness()

    disposeCodexServerRequest(registry, connection, { id: 3, method, params: {} })

    expect(connection.respondWithError).toHaveBeenCalledWith(
      3,
      -32001,
      expect.stringContaining(message)
    )
  })

  it('refuses a malformed interactive request instead of inventing an answer', () => {
    const { registry, connection } = harness()

    disposeCodexServerRequest(registry, connection, {
      id: 4,
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: {}
    })

    expect(connection.respond).not.toHaveBeenCalled()
    expect(connection.respondWithError).toHaveBeenCalledWith(
      4,
      -32001,
      'Orca could not model item/commandExecution/requestApproval as a durable prompt'
    )
  })

  it('enumerates every server request in the negotiated stable schema', () => {
    expect(new Set(CODEX_BLOCKING_SERVER_REQUEST_METHODS)).toEqual(
      new Set([
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
      ])
    )
  })

  it('bounds the future-method fallback to one explicit rejection', () => {
    const { registry, connection } = harness()

    disposeCodexServerRequest(registry, connection, {
      id: 5,
      method: 'future/blockingRequest',
      params: { opaque: true }
    })

    expect(connection.respond).not.toHaveBeenCalled()
    expect(connection.respondWithError).toHaveBeenCalledOnce()
    expect(connection.respondWithError).toHaveBeenCalledWith(
      5,
      -32000,
      'Orca rejected unrecognized blocking request future/blockingRequest'
    )
  })
})
