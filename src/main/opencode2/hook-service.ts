import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { agentHookServer } from '../agent-hooks/server'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  buildOpenCode2StatusPayload,
  OpenCode2TextAccumulator,
  translateOpenCode2Event
} from './event-translator'
import { fetchOpenCode2SessionDirectory, postOpenCode2SessionInterrupt } from './service-client'
import {
  buildOpenCode2AuthHeaders,
  readOpenCode2ServiceInfo,
  type OpenCode2ServiceInfo
} from './service-discovery'
import {
  consumeOpenCode2EventStream,
  parseOpenCode2EventRecord,
  parseOpenCode2SseEnvelope,
  readOpenCode2RecordString
} from './sse-consumer'
import { OpenCode2SessionDirectoryCache } from './session-directory-cache'

// Why: opencode2 status comes from the shared service's /api/event SSE stream,
// not an injected plugin (ADR 0002); sessions attribute to Orca terminals by
// workspace directory, and every read fails soft.

const TEXT_INGEST_THROTTLE_MS = 150
const STREAM_RETRY_MS = 5000

export type OpenCode2TerminalRegistration = {
  ptyId: string
  cwd: string
  paneKey: string
  worktreeId?: string
}

// Why: daemon paths may mix separators and case (win32/darwin FS); compare on a normalized form.
function comparableDirectoryPath(value: string, platform: NodeJS.Platform): string {
  let normalized = value.replace(/\\/g, '/')
  normalized = normalized.replace(/\/{2,}/g, '/')
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

// Why: a session launched from the pane cwd or a subdir attributes to the pane;
// an ancestor directory is a different workspace.
function isSessionDirectoryInCwd(
  cwd: string,
  directory: string,
  platform: NodeJS.Platform
): boolean {
  const comparableCwd = comparableDirectoryPath(cwd, platform)
  const comparableDirectory = comparableDirectoryPath(directory, platform)
  return (
    comparableDirectory === comparableCwd || comparableDirectory.startsWith(`${comparableCwd}/`)
  )
}

export class OpenCode2HookService {
  private readonly terminals = new Map<string, OpenCode2TerminalRegistration>()
  private readonly directoryCache = new OpenCode2SessionDirectoryCache()
  private readonly pendingDirectoryFetches = new Set<string>()
  private readonly lastPromptByPaneKey = new Map<string, string>()
  private readonly textAccumulator = new OpenCode2TextAccumulator()
  private readonly lastTextIngestAtByPaneKey = new Map<string, number>()
  private controller: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null
  // Why: controller is set only after await fetch — this flag stops concurrent registerTerminal opening two streams.
  private streamOpening = false
  private attachedInterruptListener = false

  registerTerminal(registration: OpenCode2TerminalRegistration): void {
    this.terminals.set(registration.ptyId, registration)
    this.attachInterruptListener()
    this.ensureStreaming()
  }

  clearPty(ptyId: string): void {
    const registration = this.terminals.get(ptyId)
    if (registration) {
      this.terminals.delete(ptyId)
      this.lastPromptByPaneKey.delete(registration.paneKey)
      this.lastTextIngestAtByPaneKey.delete(registration.paneKey)
    }
    if (this.terminals.size === 0) {
      this.stopStreaming()
    }
  }

  /** POST the v2 service API interrupt for a session (daemon sessions outlive the PTY). */
  interruptSession(sessionId: string): void {
    void this.postInterrupt(sessionId)
  }

  private attachInterruptListener(): void {
    if (this.attachedInterruptListener) {
      return
    }
    this.attachedInterruptListener = true
    // Why: `??=` so another provider can never clobber this listener.
    agentHookServer.onInterruptInferred ??= (args) => {
      if (args.agentType === 'opencode2' && args.providerSession?.key === 'session_id') {
        this.interruptSession(args.providerSession.id)
      }
    }
  }

  private ensureStreaming(): void {
    if (this.controller || this.retryTimer || this.streamOpening) {
      return
    }
    this.streamOpening = true
    void this.openStream()
  }

  private stopStreaming(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }

  private async openStream(): Promise<void> {
    const info = readOpenCode2ServiceInfo()
    if (!info) {
      this.streamOpening = false
      this.scheduleRetry()
      return
    }
    const controller = new AbortController()
    try {
      const response = await fetch(`${info.url}/api/event`, {
        headers: { Accept: 'text/event-stream', ...buildOpenCode2AuthHeaders(info) },
        signal: controller.signal
      })
      if (!response.ok || !response.body) {
        // Why: an unread undici body can crash the process (orca#8695).
        await cancelUnreadResponseBody(response)
        throw new Error(`opencode2 service event stream failed: ${response.status}`)
      }
      this.controller = controller
      this.streamOpening = false
      void consumeOpenCode2EventStream(
        response.body,
        (payload) => this.handleEnvelope(payload, info),
        () => {
          if (this.controller?.signal === controller.signal) {
            this.controller = null
          }
          if (this.terminals.size > 0) {
            this.scheduleRetry()
          }
        }
      )
    } catch (err) {
      this.streamOpening = false
      if ((err as Error).name !== 'AbortError') {
        this.scheduleRetry()
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.terminals.size === 0) {
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.ensureStreaming()
    }, STREAM_RETRY_MS)
    this.retryTimer.unref?.()
  }

  private handleEnvelope(payload: string, info: OpenCode2ServiceInfo): void {
    const envelope = parseOpenCode2SseEnvelope(payload)
    if (!envelope) {
      return
    }
    const record = parseOpenCode2EventRecord(envelope.data)
    if (!record) {
      return
    }
    const sessionId = readOpenCode2RecordString(record, 'sessionID')
    if (!sessionId) {
      return
    }
    const directory =
      envelope.event === 'session.created'
        ? this.rememberSessionDirectoryFromLocation(sessionId, record)
        : this.directoryCache.get(sessionId)
    if (!directory) {
      // Why: unknown session — fetch its directory once so later events attribute.
      void this.fetchSessionDirectory(sessionId, info)
      return
    }
    const terminal = this.findTerminalByDirectory(directory)
    if (!terminal) {
      return
    }
    this.translateEvent(envelope.event, record, sessionId, terminal)
  }

  private translateEvent(
    event: string,
    record: Record<string, unknown>,
    sessionId: string,
    terminal: OpenCode2TerminalRegistration
  ): void {
    const translated = translateOpenCode2Event(event, record, this.textAccumulator)
    if (!translated) {
      return
    }
    const paneKey = terminal.paneKey
    if (translated.role === 'user' && translated.text) {
      this.lastPromptByPaneKey.set(paneKey, translated.text)
    }
    const prompt = this.lastPromptByPaneKey.get(paneKey) ?? undefined
    const payload = buildOpenCode2StatusPayload(translated, prompt)
    if (!payload) {
      return
    }

    // Why: deltas stream at high rate — throttle per pane like the v1 plugin,
    // but always deliver the final text.ended text.
    if (event === 'session.text.delta') {
      const lastIngest = this.lastTextIngestAtByPaneKey.get(paneKey) ?? 0
      const now = Date.now()
      if (now - lastIngest < TEXT_INGEST_THROTTLE_MS) {
        return
      }
      this.lastTextIngestAtByPaneKey.set(paneKey, now)
    } else if (event === 'session.text.ended') {
      this.lastTextIngestAtByPaneKey.delete(paneKey)
    }

    this.ingest(paneKey, terminal, payload, sessionId)
  }

  private ingest(
    paneKey: string,
    terminal: OpenCode2TerminalRegistration,
    payload: ParsedAgentStatusPayload,
    sessionId: string
  ): void {
    const parsedPaneKey = parsePaneKey(paneKey)
    const providerSession: AgentProviderSessionMetadata = { key: 'session_id', id: sessionId }
    agentHookServer.ingestTerminalStatus({
      paneKey,
      ...(parsedPaneKey ? { tabId: parsedPaneKey.tabId } : {}),
      ...(terminal.worktreeId ? { worktreeId: terminal.worktreeId } : {}),
      connectionId: null,
      payload,
      providerSession
    })
  }

  private rememberSessionDirectoryFromLocation(
    sessionId: string,
    record: Record<string, unknown>
  ): string | null {
    const location = record.location
    const directory =
      location && typeof location === 'object'
        ? readOpenCode2RecordString(location as Record<string, unknown>, 'directory')
        : null
    if (!directory) {
      return null
    }
    this.directoryCache.remember(sessionId, directory)
    return directory
  }

  private async fetchSessionDirectory(
    sessionId: string,
    info: OpenCode2ServiceInfo
  ): Promise<void> {
    if (
      this.pendingDirectoryFetches.has(sessionId) ||
      !this.directoryCache.shouldFetch(sessionId)
    ) {
      return
    }
    this.pendingDirectoryFetches.add(sessionId)
    try {
      const result = await fetchOpenCode2SessionDirectory(info, sessionId)
      if (result.ok) {
        this.directoryCache.remember(sessionId, result.directory)
      } else {
        this.directoryCache.rememberFailure(sessionId)
      }
    } finally {
      this.pendingDirectoryFetches.delete(sessionId)
    }
  }

  private async postInterrupt(sessionId: string): Promise<void> {
    const info = readOpenCode2ServiceInfo()
    if (info) {
      await postOpenCode2SessionInterrupt(info, sessionId)
    }
  }

  private findTerminalByDirectory(directory: string): OpenCode2TerminalRegistration | null {
    for (const registration of this.terminals.values()) {
      if (isSessionDirectoryInCwd(registration.cwd, directory, process.platform)) {
        return registration
      }
    }
    return null
  }
}

export const openCode2HookService = new OpenCode2HookService()
