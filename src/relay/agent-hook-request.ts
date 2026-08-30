import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import {
  isHookRequestTruncatedError,
  type HookTransportInterferenceTracker
} from '../shared/agent-hook-transport-interference'
import type { AgentHookSource } from '../shared/agent-hook-relay'

export async function handleRelayHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    token: string
    env: string
    state: HookListenerState
    transportInterference: HookTransportInterferenceTracker
    applyEvent: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string
    ) => void
    scheduleAssistantMessageRetry: (
      source: AgentHookSource,
      body: unknown,
      event: AgentHookEventPayload,
      env?: string,
      version?: string
    ) => void
    scheduleCodexSubagentPoll: (
      source: AgentHookSource,
      body: unknown,
      event: AgentHookEventPayload,
      env?: string,
      version?: string
    ) => void
    bodyEnv: (body: unknown) => string | undefined
    bodyVersion: (body: unknown) => string | undefined
  }
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end()
    return
  }
  if (req.headers['x-orca-agent-hook-token'] !== options.token) {
    res.writeHead(403)
    res.end()
    return
  }
  let destroyedBySlowlorisCap = false
  req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
    destroyedBySlowlorisCap = true
    req.destroy()
  })
  try {
    const source = resolveHookSource(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (!source) {
      res.writeHead(404)
      res.end()
      return
    }
    const body = await readRequestBody(req)
    const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
    const event = normalizeHookPayload(options.state, source, hookBody, options.env, {
      deferCompactOwnershipToClient: true
    })
    if (event) {
      const env = options.bodyEnv(hookBody),
        version = options.bodyVersion(hookBody)
      options.applyEvent(event, source, env, version)
      options.scheduleAssistantMessageRetry(source, hookBody, event, env, version)
      options.scheduleCodexSubagentPoll(source, hookBody, event, env, version)
    }
    res.writeHead(204)
    res.end()
  } catch (err) {
    if (isHookRequestTruncatedError(err) && !destroyedBySlowlorisCap) {
      options.transportInterference.record({ source: null, error: err })
    }
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    res.writeHead(204)
    res.end()
  }
}
