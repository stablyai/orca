import type { IncomingMessage, ServerResponse } from 'node:http'

import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import {
  isHookRequestTruncatedError,
  type HookTransportInterferenceTracker
} from '../shared/agent-hook-transport-interference'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'

export type RelayHookHttpHandlerOptions = {
  token: string
  env: string
  state: HookListenerState
  retryScheduler: AgentHookResultRetryScheduler
  transportInterference: HookTransportInterferenceTracker
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ) => void
}

export async function handleRelayHookHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RelayHookHttpHandlerOptions
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
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const source = resolveHookSource(pathname)
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
      // TODO: source env/version from normalizeHookPayload once its result carries validated metadata.
      const env = hookBodyEnv(hookBody)
      const version = hookBodyVersion(hookBody)
      options.applyEvent(event, source, env, version)
      options.retryScheduler.scheduleAssistantMessageRetry(source, hookBody, event, env, version)
      options.retryScheduler.scheduleCodexSubagentPoll(source, hookBody, event, env, version)
    }
    res.writeHead(204)
    res.end()
  } catch (error) {
    if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
      options.transportInterference.record({ source: null, error })
    }
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    res.writeHead(204)
    res.end()
  }
}
