import type { IncomingMessage, ServerResponse } from 'node:http'

import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import {
  isHookRequestTruncatedError,
  type HookRequestTruncatedError
} from '../shared/agent-hook-transport-interference'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import type { AgentHookEmitterProcessResolver } from '../shared/agent-hook-emitter-process'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'

export async function handleRelayAgentHookRequest(args: {
  req: IncomingMessage
  res: ServerResponse
  token: string
  state: HookListenerState
  env: string
  emitterProcessResolver: AgentHookEmitterProcessResolver
  retryScheduler: AgentHookResultRetryScheduler
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ) => void
  recordTransportInterference: (error: HookRequestTruncatedError) => void
}): Promise<void> {
  if (args.req.method !== 'POST') {
    args.res.writeHead(404)
    args.res.end()
    return
  }
  if (args.req.headers['x-orca-agent-hook-token'] !== args.token) {
    args.res.writeHead(403)
    args.res.end()
    return
  }
  let destroyedBySlowlorisCap = false
  args.req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
    destroyedBySlowlorisCap = true
    args.req.destroy()
  })
  try {
    const pathname = new URL(args.req.url ?? '/', 'http://127.0.0.1').pathname
    const source = resolveHookSource(pathname)
    if (!source) {
      args.res.writeHead(404)
      args.res.end()
      return
    }
    const body = await readRequestBody(args.req)
    const hookBody = mergeAgentHookRequestHeaders(body, args.req.headers)
    const event = normalizeHookPayload(args.state, source, hookBody, args.env, {
      deferCompactOwnershipToClient: true
    })
    if (event) {
      const emitterProcess = await args.emitterProcessResolver(
        source,
        event.reportedEmitterProcessId
      )
      const verifiedEvent = { ...event, ...(emitterProcess ? { emitterProcess } : {}) }
      const env = hookBodyEnv(hookBody)
      const version = hookBodyVersion(hookBody)
      args.applyEvent(verifiedEvent, source, env, version)
      args.retryScheduler.scheduleAssistantMessageRetry(
        source,
        hookBody,
        verifiedEvent,
        env,
        version
      )
      args.retryScheduler.scheduleCodexSubagentPoll(source, hookBody, verifiedEvent, env, version)
    }
    args.res.writeHead(204)
    args.res.end()
  } catch (error) {
    if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
      args.recordTransportInterference(error)
    }
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    args.res.writeHead(204)
    args.res.end()
  }
}
