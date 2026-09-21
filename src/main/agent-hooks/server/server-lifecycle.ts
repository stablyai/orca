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
import { drainAgentHookSpool, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { clearAllListenerCaches } from '../../../shared/agent-hook-listener/listener-state'
import { trackEmptyPaneKeyHook } from './server-transport-rules'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'

export abstract class AgentHookServerLifecycle extends AgentHookServerRuntimeEnv {
  /** Start the loopback listener after hydration and spool replay have settled. */
  async start(options?: {
    env?: string
    userDataPath?: string
    endpointNamespace?: string
  }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      // Why: dev builds share one userData path; namespace per instance while packaged keeps the stable path for PTY reconnect.
      this.configureEndpointPaths(options.userDataPath, options.endpointNamespace)
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.lastWrittenJson = null
    // Why: hydrate before binding the listener so an early hook POST runs against a populated map.
    if (this.lastStatusFilePath) {
      this.hydrateLastStatusFromDisk()
    }
    this.captureHydratedAuthorityCommitments()
    // Drain before binding the listener so replay cannot race a live hook during startup.
    if (this.endpointDir) {
      drainAgentHookSpool({
        endpointDir: this.endpointDir,
        getPersistedLaunchTokenHash: (paneKey) =>
          this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
        ingest: (record: SpoolRecord) => this.ingestSpoolRecord(record)
      })
    }
    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      // Why: authenticate before spending work reading an untrusted body.
      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }
      // Why: bound request time so a stalled client can't hold a socket open (slowloris).
      // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
      let destroyedBySlowlorisCap = false
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        destroyedBySlowlorisCap = true
        req.destroy()
      })
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      try {
        const body = await readRequestBody(req)
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
        // Why: merge transport headers before normalization so relay-compatible fields have one canonical path.
        const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
        trackEmptyPaneKeyHook(hookBody)
        const aliasedBody = this.normalizeHookBodyPaneKeyAlias(hookBody)
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
          const event =
            statusDisposition === 'restart'
              ? { ...normalized.event, launchToken: undefined }
              : normalized.event
          if (statusDisposition === 'restart') {
            // Why: a retired pane accepting a new turn is a different agent session behind the
            // same key — later observations must not be ordered against the retired one.
            this.observations.rebind(event.paneKey)
          }
          this.recordCurrentAuthorityObservation(event)
          const enriched = this.applyNormalizedStatus(event, normalized.onAccepted)
          this.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
          this.scheduleCodexSubagentPoll(source, aliasedBody, enriched)
        }
        res.writeHead(204)
        res.end()
      } catch (error) {
        // Why (#11217): an authenticated POST whose body dies short of its own Content-Length was cut
        // by something on the loopback path, not by a bad payload. Fail open as before, but count it —
        // this is the one failure mode that silently stops status for every runtime at once.
        if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
          this.transportInterference.record({ source: resolveHookSource(pathname) ?? null, error })
        }
        // Why: fail open — return success on malformed payloads so a broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    }
    // Why: node ignores a returned promise, so the handler must settle it itself; handleRequest never rejects.
    this.server = createServer((req, res) => {
      void handleRequest(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => {
        // Why: swap the startup reject-handler for a logging one so a later runtime 'error' can't crash main as an unhandled event.
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        this.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    // Why: flush the pending debounced write before clearing the map, else a hook <250ms before quit is lost on relaunch.
    this.flushStatusPersistSync()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
    this.onPaneStatusCleared = null
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    this.clearAllCodexSubagentPolls()
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    this.lastStatusFilePath = null
    this.lastWrittenJson = null
    this.runtimeObservedStatusPaneKeys.clear()
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
    this.legacyPaneKeyAliases.clear()
    // Why: don't unlink the endpoint file — a stale file matches fail-open and avoids a TOCTOU race with a concurrent Orca.
    clearAllListenerCaches(this.state)
    this.notifyStatusChangeListeners()
  }
}
