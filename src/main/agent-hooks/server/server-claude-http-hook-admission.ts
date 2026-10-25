import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { isPlainObject } from '../hooks-json-read'
import { CLAUDE_HTTP_TOOL_HOOK_EVENTS } from '../../claude/claude-managed-hook-events'

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

// The script exits before posting under these; an http entry cannot, so the listener drops them.
function isGuardedHost(headers: IncomingHttpHeaders): boolean {
  return (
    headerValue(headers, 'x-orca-claude-job-dir') !== '' ||
    headerValue(headers, 'x-orca-devin-project-dir') !== '' ||
    headerValue(headers, 'x-orca-grok-hook-event') !== '' ||
    (headerValue(headers, 'x-orca-cursor-version') !== '' &&
      headerValue(headers, 'x-orca-cursor-project-dir') !== '')
  )
}

/**
 * An http entry cannot prove its process or carry a non-Latin-1 worktree path, so a tool event
 * is accepted only for the Claude session that already owns the pane, and borrows that row's
 * process and worktree. A nested `claude -p` sharing the pane env has another session_id.
 */
export function admitClaudeHttpToolHook(
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders,
  lastStatusForPane: (paneKey: string) => AgentHookEventPayload | undefined
): Record<string, unknown> | null {
  if (source !== 'claude' || isGuardedHost(headers) || !isPlainObject(body)) {
    return null
  }
  const payload = body.payload
  if (typeof body.paneKey !== 'string' || !isPlainObject(payload)) {
    return null
  }
  const eventName = payload.hook_event_name
  if (typeof eventName !== 'string' || !CLAUDE_HTTP_TOOL_HOOK_EVENTS.includes(eventName)) {
    return null
  }
  const owner = lastStatusForPane(body.paneKey.trim())
  const sessionId = owner?.providerSession?.id
  if (
    !owner ||
    owner.connectionId !== null ||
    !sessionId ||
    payload.session_id !== sessionId ||
    owner.agentPresence?.ended
  ) {
    return null
  }
  const ownerProcess = owner.agentPresence?.process
  return {
    ...body,
    worktreeId: owner.worktreeId,
    agentProcess: ownerProcess ? JSON.stringify(ownerProcess) : undefined
  }
}

/** Claude shows a hook error for any non-2xx, so http entries fail open as quietly as the script. */
export function endHookRequest(res: ServerResponse, httpHook: boolean, status: number): void {
  res.writeHead(httpHook ? 204 : status)
  res.end()
}

/** Script bodies pass through; http bodies must be admitted, or the request ends with 204. */
export function admitHttpHookBody(
  httpHook: boolean,
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders,
  state: Pick<HookListenerState, 'lastStatusByPaneKey'>
): unknown {
  return httpHook
    ? admitClaudeHttpToolHook(source, body, headers, (paneKey) =>
        state.lastStatusByPaneKey.get(paneKey)
      )
    : body
}
