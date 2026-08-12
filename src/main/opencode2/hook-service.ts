import { sep } from 'node:path'
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

// Why: opencode2 keeps sessions in a shared background service, so status
// events come from the service's `/api/event` SSE stream instead of an
// injected plugin (docs/adr/0002-opencode2-hooks-via-service-event-stream.md).
// Sessions are attributed to Orca terminals by workspace directory; events for
// sessions outside Orca's opencode2 terminals are ignored. All reads are
// best-effort — a missing service, beta API drift, or schema change degrades
// to "no status" without affecting the terminal.

const SESSION_DIRECTORY_CACHE_MAX = 512
const TEXT_INGEST_THROTTLE_MS = 150
const STREAM_RETRY_MS = 5000

export type OpenCode2TerminalRegistration = {
  ptyId: string
  cwd: string
  paneKey: string
  worktreeId?: string
}

// Why: attribute a daemon session to the terminal whose cwd is the session's
// directory or an ancestor of it (sessions launched from a worktree subdir).
// The reverse (session directory is an ancestor of the pane cwd) is a
// different workspace and must not flip this pane's status.
function isSessionDirectoryInCwd(cwd: string, directory: string): boolean {
  const boundary = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`
  return directory === cwd || directory.startsWith(boundary)
}

export class OpenCode2HookService {
  private readonly terminals = new Map<string, OpenCode2TerminalRegistration>()
  private readonly sessionDirectories = new Map<string, string>()
  private readonly lastPromptByPaneKey = new Map<string, string>()
  private readonly textAccumulator = new OpenCode2TextAccumulator()
  private readonly lastTextIngestAtByPaneKey = new Map<string, number>()
  private controller: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null
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
    if (this.controller || this.retryTimer) {
      return
    }
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
        : (this.sessionDirectories.get(sessionId) ?? null)
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

    // Why: text deltas can arrive many times per second during streaming;
    // throttle per pane like the v1 plugin did, but always deliver the final
    // `session.text.ended` full text.
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
    this.cacheSessionDirectory(sessionId, directory)
    return directory
  }

  private cacheSessionDirectory(sessionId: string, directory: string): void {
    if (this.sessionDirectories.size >= SESSION_DIRECTORY_CACHE_MAX) {
      const oldest = this.sessionDirectories.keys().next().value
      if (typeof oldest === 'string') {
        this.sessionDirectories.delete(oldest)
      }
    }
    this.sessionDirectories.set(sessionId, directory)
  }

  private async fetchSessionDirectory(
    sessionId: string,
    info: OpenCode2ServiceInfo
  ): Promise<void> {
    if (this.sessionDirectories.has(sessionId)) {
      return
    }
    try {
      const response = await fetch(`${info.url}/api/session/${encodeURIComponent(sessionId)}`, {
        headers: { ...buildOpenCode2AuthHeaders(info) },
        signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) {
        await cancelUnreadResponseBody(response)
        return
      }
      const body = (await response.json()) as {
        data?: { location?: { directory?: unknown } }
      }
      const directory = body.data?.location?.directory
      if (typeof directory === 'string' && directory.trim().length > 0) {
        this.cacheSessionDirectory(sessionId, directory.trim())
      }
    } catch {
      // best-effort; the next event retries attribution
    }
  }

  private async postInterrupt(sessionId: string): Promise<void> {
    const info = readOpenCode2ServiceInfo()
    if (!info) {
      return
    }
    try {
      const response = await fetch(
        `${info.url}/api/session/${encodeURIComponent(sessionId)}/interrupt`,
        {
          method: 'POST',
          headers: { ...buildOpenCode2AuthHeaders(info) },
          signal: AbortSignal.timeout(5000)
        }
      )
      await cancelUnreadResponseBody(response)
    } catch {
      // best-effort; the TUI's own Escape handling remains the fallback
    }
  }

  private findTerminalByDirectory(directory: string): OpenCode2TerminalRegistration | null {
    for (const registration of this.terminals.values()) {
      if (isSessionDirectoryInCwd(registration.cwd, directory)) {
        return registration
      }
    }
    return null
  }
}

export const openCode2HookService = new OpenCode2HookService()
