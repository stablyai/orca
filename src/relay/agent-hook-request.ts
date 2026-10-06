import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../shared/agent-hook-listener/listener-limits'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import { mergeAgentHookRequestHeaders } from '../shared/agent-hook-listener/hook-envelope'
import { readRequestBody } from '../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../shared/agent-hook-listener/source-routing'
import type { createHookTransportInterferenceTracker } from '../shared/agent-hook-transport-interference'
import { isHookRequestTruncatedError } from '../shared/agent-hook-transport-interference'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import type { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'
import { bindOpenCodeTuiSession } from '../shared/agent-hook-listener/opencode-session-registry'

export async function handleRelayHookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    token: string
    env: string
    state: HookListenerState
    isPaneSurfaceRetired: (paneKey: string) => boolean
    getAgentLaunchToken: (paneKey: string) => string | undefined
    applyEvent: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string
    ) => AgentHookEventPayload | undefined
    ingestTmuxHook?: (source: AgentHookSource, body: unknown) => Promise<boolean>
    retryScheduler: AgentHookResultRetryScheduler
    transportInterference: ReturnType<typeof createHookTransportInterferenceTracker>
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
  // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
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
    if (await options.ingestTmuxHook?.(source, hookBody)) {
      res.writeHead(204)
      res.end()
      return
    }
    let admittedOpenCodeTuiOwner = false
    const event = normalizeHookPayload(options.state, source, hookBody, options.env, {
      deferCompactOwnershipToClient: true,
      admitOpenCodeTui: (identity) => {
        const admission = admitRelayOpenCodeTui(options, identity)
        admittedOpenCodeTuiOwner = admission === true
        return admission
      }
    })
    if (event) {
      // TODO: once normalizeHookPayload returns validated env/version, drop bodyEnv/bodyVersion and source them from the listener result.
      const env = hookBodyEnv(hookBody)
      const version = hookBodyVersion(hookBody)
      const stored = options.applyEvent(event, source, env, version)
      if (stored) {
        if (admittedOpenCodeTuiOwner) {
          bindOpenCodeTuiSession(options.state, source, hookBody, event.providerSession?.id)
        }
        options.retryScheduler.scheduleAssistantMessageRetry(source, hookBody, stored, env, version)
        options.retryScheduler.scheduleTranscriptPoll(source, hookBody, stored, env, version)
      }
    }
    res.writeHead(204)
    res.end()
  } catch (err) {
    // Why (#11217): a remote host can run the same IDS; count truncations here so a blocked SSH
    // relay reports the cause instead of an anonymous "hook request failed".
    if (isHookRequestTruncatedError(err) && !destroyedBySlowlorisCap) {
      options.transportInterference.record({ source: null, error: err })
    }
    // Why: hooks fail open (204 on any error) so a buggy agent never blocks the run; still log so the 204 doesn't mask bugs.
    process.stderr.write(
      `[relay-hook-server] hook request failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    res.writeHead(204)
    res.end()
  }
}

export function admitRelayOpenCodeTui(
  host: {
    isPaneSurfaceRetired: (paneKey: string) => boolean
    getAgentLaunchToken: (paneKey: string) => string | undefined
  },
  identity: Pick<AgentHookEventPayload, 'paneKey' | 'launchToken'>
): boolean | 'preserve-poster' {
  if (host.isPaneSurfaceRetired(identity.paneKey)) {
    return false
  }
  const expected = host.getAgentLaunchToken(identity.paneKey)
  return expected ? identity.launchToken?.trim() === expected : 'preserve-poster'
}
