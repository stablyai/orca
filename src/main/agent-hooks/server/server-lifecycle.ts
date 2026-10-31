import { AgentHookStartup, listenForAgentHooks } from '../../../shared/agent-hook-startup'
import { checkHookOwnerPresence } from '../../../shared/agent-hook-owner-presence'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import {
  CLAUDE_STATUSLINE_PATHNAME,
  parseClaudeStatusLineBody
} from '../../../shared/claude-statusline-rate-limits'
import { mergeAgentHookRequestHeaders } from '../../../shared/agent-hook-listener/hook-envelope'
import { readRequestBody } from '../../../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../../../shared/agent-hook-listener/source-routing'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../../../shared/agent-hook-listener/listener-limits'
import { isHookRequestTruncatedError } from '../../../shared/agent-hook-transport-interference'
import { clearAllListenerCaches } from '../../../shared/agent-hook-listener/listener-state'
import { trackEmptyPaneKeyHook } from './server-transport-rules'
import { AgentHookServerStatusHookLifecycle } from './server-status-hook-lifecycle'
import { OPENCODE_STARTUP_PROMPT_CLAIM_PATH } from '../../../shared/opencode-startup-prompt'
import { CLAUDE_AGENT_VIEW_PATH } from '../../../shared/claude-agent-view'

type HookServerStartOptions = {
  env?: string
  userDataPath?: string
  endpointNamespace?: string
  statusHooksEnabled?: boolean
}

export abstract class AgentHookServerLifecycle extends AgentHookServerStatusHookLifecycle {
  private readonly startup = new AgentHookStartup()

  start(options?: HookServerStartOptions): Promise<void> {
    return this.startup.start((isCurrent) => this.startListener(options, isCurrent))
  }

  private async startListener(
    options: HookServerStartOptions | undefined,
    isCurrent: () => boolean
  ): Promise<void> {
    if (this.server) {
      if (options?.statusHooksEnabled !== undefined) {
        this.setStatusHooksEnabled(options.statusHooksEnabled)
      }
      return
    }
    this.statusHooksEnabled = options?.statusHooksEnabled !== false

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      // Namespace dev endpoints per instance; packaged endpoints stay stable for PTY reconnect.
      this.configureEndpointPaths(options.userDataPath, options.endpointNamespace)
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.closeStatusSnapshotWriter()
    if (this.statusHooksEnabled) {
      await this.initializeStatusHookOwner()
    }
    if (!isCurrent()) {
      return
    }
    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }
      const statusHookGeneration = this.statusHookGeneration
      const isStatusCurrent = () =>
        isCurrent() && this.statusHooksEnabled && this.statusHookGeneration === statusHookGeneration
      // Track our slowloris timeout so it cannot count as external transport interference.
      let destroyedBySlowlorisCap = false
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        destroyedBySlowlorisCap = true
        req.destroy()
      })
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      try {
        const body = await readRequestBody(req)
        if (!isCurrent()) {
          res.writeHead(204)
          res.end()
          return
        }
        if (pathname === OPENCODE_STARTUP_PROMPT_CLAIM_PATH) {
          res.writeHead(200, { 'content-type': 'application/json' })
          const claim = this.onStartupPromptClaim?.(body)
          res.end(
            JSON.stringify({
              allowed: claim === true,
              ...(claim === 'pending' ? { pending: true } : {})
            })
          )
          return
        }
        if (!isStatusCurrent()) {
          res.writeHead(404)
          res.end()
          return
        }
        if (pathname === CLAUDE_AGENT_VIEW_PATH) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(this.claudeAgentViews.receive(body)))
          return
        }
        await this.initializeStatusHookOwner()
        if (!isStatusCurrent()) {
          res.writeHead(404)
          res.end()
          return
        }
        if (pathname === CLAUDE_STATUSLINE_PATHNAME) {
          const statusLineEvent = parseClaudeStatusLineBody(body)
          if (statusLineEvent) {
            this.onClaudeStatusLine?.(statusLineEvent)
          }
          res.writeHead(204)
          res.end()
          return
        }
        const source = resolveHookSource(pathname)
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }
        const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
        trackEmptyPaneKeyHook(hookBody)
        const aliasedBody = this.normalizeHookBodyPaneKeyAlias(hookBody)
        if (await this.ingestTmuxHook(source, aliasedBody)) {
          res.writeHead(204)
          res.end()
          return
        }
        await checkHookOwnerPresence(this.state, source, aliasedBody, this.env, (paneKey) =>
          this.checkAgentPresence(paneKey)
        )
        if (!isStatusCurrent()) {
          res.writeHead(204)
          res.end()
          return
        }
        const normalized = this.normalizeLocalHookPayload(source, aliasedBody)
        const statusDisposition = normalized.event
          ? this.getAgentStatusDisposition(normalized.event.paneKey, {
              source,
              hookEventName: normalized.event.hookEventName,
              isReplay: normalized.event.isReplay,
              hasExplicitPrompt: normalized.event.hasExplicitPrompt,
              launchToken: normalized.event.launchToken
            })
          : 'suppress'
        if (normalized.event && statusDisposition !== 'suppress') {
          const restartedAuthority =
            statusDisposition === 'restart' && source === 'omp'
              ? this.restoreRetiredStatusRestart(normalized.event.paneKey)
              : undefined
          const event =
            statusDisposition === 'restart'
              ? {
                  ...normalized.event,
                  launchToken: undefined,
                  ...(restartedAuthority
                    ? {
                        ...restartedAuthority,
                        tabId: parsePaneKey(restartedAuthority.paneKey)?.tabId
                      }
                    : {})
                }
              : normalized.event
          if (statusDisposition === 'restart') {
            // A new session must not inherit the retired one's observation order.
            this.observations.rebind(event.paneKey)
          }
          this.recordCurrentAuthorityObservation(event)
          const enriched = this.applyObservedLocalHook(event, normalized.onAccepted)
          if (enriched) {
            this.checkAgentPresenceAfterHook(event, enriched)
            this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
            this.scheduleTranscriptPoll(source, aliasedBody, enriched)
          }
        }
        res.writeHead(204)
        res.end()
      } catch (error) {
        if (pathname === OPENCODE_STARTUP_PROMPT_CLAIM_PATH) {
          if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
            res.writeHead(503)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"allowed":false}')
          return
        }
        // Authenticated body truncation can interrupt all hook status; record it despite fail-open handling (#11217).
        if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
          this.transportInterference.record({ source: resolveHookSource(pathname) ?? null, error })
        }
        // Malformed hooks must not block the agent.
        res.writeHead(204)
        res.end()
      }
    }
    // Node ignores handler promises; handleRequest catches request errors internally.
    this.server = createServer((req, res) => {
      void handleRequest(req, res)
    })
    const server = this.server
    try {
      await listenForAgentHooks(
        server,
        0,
        isCurrent,
        () => {
          const address = server.address()
          if (address && typeof address === 'object') {
            this.port = address.port
          }
          this.activateClaudeHelperObservations()
          this.maybeWriteEndpointFile()
        },
        (error) => console.error('[agent-hooks] server error', error)
      )
    } catch (error) {
      this.rollbackTransportStart()
      throw error
    }
    if (isCurrent() && this.statusHooksEnabled) {
      this.startOpenCodeBinderLoop()
    }
  }

  private rollbackTransportStart(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
  }

  /** Quit retains status until chat teardown reads resumable child and background work. */
  stop(options?: { keepStatus?: boolean }): void {
    this.startup.stop()
    this.claudeAgentViews.clear()
    // Terminal status may still have a pending write while hook ingress is disabled.
    if (this.statusHooksEnabled || this.statusPersistTimer) {
      this.flushStatusPersistSync()
    }
    this.stopOpenCodeBinderLoop()
    this.stopTmuxStatus()
    this.rollbackTransportStart()
    this.env = 'production'
    this.onAgentStatus = null
    this.onClaudeStatusLine = null
    this.clearStartupPromptClaims?.()
    this.clearStartupPromptClaims = null
    this.onStartupPromptClaim = null
    this.onPaneStatusCleared = null
    this.onTransportInterference = null
    this.transportInterference.reset()
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    this.hookSilenceRechecks.clear()
    this.programStatusFacetRepublishes.clear()
    this.clearAllTranscriptPolls()
    this.claudeOwedNotificationExpiry.clearAll()
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    this.lastStatusFilePath = null
    this.closeStatusSnapshotWriter()
    this.runtimeObservedStatusPaneKeys.clear()
    this.paneKeyByTerminalHandle.clear()
    this.hydratedAuthorityCommitments = Object.freeze([])
    this.hydratedLaunchTokenHashByPaneKey.clear()
    this.persistedAuthorityCommitmentsByPaneKey.clear()
    this.revokedHydratedAuthorityCommitments = new WeakSet()
    this.currentAuthorityObservations.clear()
    this.promptSentDedupeByPaneKey.clear()
    this.closedAgentStatusTabIds.clear()
    this.closedAgentStatusPaneKeys.clear()
    this.restartedStatusLaunchTokenHashByPaneKey.clear()
    this.retiredPaneFencesByKey.clear()
    this.connectionTimestampWatermarkById.clear()
    this.evidenceObservedAtByPaneKey.clear()
    this.programStatusFacets.clear()
    this.activeHookTurnCompletedAtByPaneKey.clear()
    this.legacyPaneKeyAliases.clear()
    this.paneKeyAliasPersistenceListener = null
    this.ownerStateInitialized = false
    // Leave the endpoint: stale files fail open, and unlinking can race another Orca instance.
    clearAllListenerCaches(this.state)
    if (!options?.keepStatus) {
      this.resetCanonicalStatus()
      this.notifyStatusChangeListeners()
    }
    this.paneStatusClearListeners.clear()
    this.statusDropListeners.clear()
    this.statusChangeListeners.clear()
    this.statusFreshnessListeners.clear()
    this.providerSessionChangeListeners.clear()
    this.enrichedStatusListeners.clear()
    this.statusRowMutationListeners.clear()
  }
}
