import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import {
  renderRecoveryItem,
  renderRecoveryCoverage
} from '../native-chat/agent-session-context-transfer-text'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { turnInputFor } from './codex-structured-message-options'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'

export const codexHistoricalInputBytes =
  (
    sessions: Map<string, CodexSession>
  ): NonNullable<StructuredAgentSessionAdapter['historicalInputBytes']> =>
  async (input) => {
    const session = requireLiveCodexSession(sessions, input.sessionId)
    return {
      bytes: Buffer.byteLength(
        JSON.stringify({
          method: 'turn/start',
          params: { threadId: session.threadId, input: turnInputFor(session, input.body) }
        })
      ),
      limit: Number.MAX_SAFE_INTEGER
    }
  }

export const injectCodexHistoricalContext =
  (
    sessions: Map<string, CodexSession>
  ): NonNullable<StructuredAgentSessionAdapter['injectHistoricalContext']> =>
  async (input) => {
    const session = sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || session.ended) {
      throw new Error('Codex history target changed')
    }
    input.signal?.throwIfAborted()
    let requestId: number | undefined
    try {
      await session.connection.request(
        'thread/inject_items',
        {
          threadId: session.threadId,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: renderRecoveryCoverage(input.deliveryId, input.coverageText)
                }
              ]
            },
            ...input.messages.map((message) => ({
              type: 'message',
              role: message.role,
              content: [
                {
                  type: message.role === 'user' ? 'input_text' : 'output_text',
                  text: renderRecoveryItem(input.deliveryId, message)
                }
              ]
            }))
          ]
        },
        {
          timeoutMs: null,
          onRequestId: (id) => {
            requestId = id
          }
        }
      )
    } catch (error) {
      if (
        isCodexAppServerRequestError(error) &&
        error.method === 'thread/inject_items' &&
        error.code === -32601
      ) {
        return { kind: 'unsupported' }
      }
      throw error
    }
    if (requestId === undefined) {
      throw new Error('Codex injection did not expose its request identity')
    }
    return { kind: 'injected', requestId: String(requestId) }
  }
