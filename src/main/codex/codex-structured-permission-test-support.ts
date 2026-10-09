import { vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

export function turnSession(
  request: CodexAppServerConnection['request'],
  threadPermissionMode: AgentChatPermissionMode = 'ask'
): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    threadPermissionMode,
    approvalsReviewerSupported: true,
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
}

export function sendTurn(session: CodexSession, id: string): Promise<unknown> {
  return startCodexTurn(session, {
    clientMessageId: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
  })
}

export function recordingRequest() {
  const turns: Record<string, unknown>[] = []
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'turn/start') {
      turns.push(params ?? {})
      return { turn: { id: `turn-${turns.length}` } }
    }
    return method === 'model/list'
      ? { data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }], nextCursor: null }
      : {}
  })
  return { request, turns }
}
