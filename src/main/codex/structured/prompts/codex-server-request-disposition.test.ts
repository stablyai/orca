import { describe, expect, it, vi } from 'vitest'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CodexPromptRegistry
} from './codex-prompt-registry'
import './codex-structured-prompt-replies'

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
          ? {
              ...promptParams,
              questions: [
                {
                  id: 'q1',
                  header: 'Choice',
                  question: 'Proceed?',
                  options: [{ label: 'Yes', description: 'Continue' }]
                }
              ]
            }
          : promptParams
    })

    expect(result.kind).toBe('prompt')
    expect(connection.respond).not.toHaveBeenCalled()
    expect(connection.respondWithError).not.toHaveBeenCalled()
  })

  it('refuses an unrenderable ordinary request whole with one error and no owner', () => {
    const { registry, connection } = harness()
    expect(
      disposeCodexServerRequest(registry, connection, {
        id: 0,
        method: CODEX_USER_INPUT_METHOD,
        params: { ...promptParams, questions: [{ id: 'q1' }] }
      }).kind
    ).toBe('admission-refused')
    expect(connection.respond).not.toHaveBeenCalled()
    expect(connection.respondWithError).toHaveBeenCalledOnce()
    expect(registry.sizes).toEqual({ prompts: 0, journalBindings: 0 })
    expect(registry.bytes).toBe(0)
  })
})
