import {
  scanReportingProgress,
  setServiceScanRowInterest,
  clearServiceScanRowInterest
} from './session-scanner-service-scan'
import { setActiveSink } from '../../observability/tracer'
import { requestSessionSearchRoots } from './session-scanner-service-root-request'
import { readAiVaultFirstUserPrompt } from '../prompts/session-first-user-prompt-read'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence
} from '../parse-cache/session-parse-cache-persistence'
import { invalidateSessionParseCacheEntry } from '../parse-cache/session-parse-cache-store'
import { SessionScannerServiceSearch } from './session-scanner-service-search'
import {
  AI_VAULT_SERVICE_PROTOCOL_VERSION,
  aiVaultServiceLane,
  cacheServiceTitle,
  isAiVaultServiceRequest,
  type AiVaultServiceChildMessage,
  type AiVaultServiceParentMessage,
  type AiVaultServiceRequest,
  type AiVaultServiceResultValue
} from './session-scanner-service-protocol'
import {
  readAiVaultSessionTitlesFromFiles,
  type CachedAiVaultSessionTitle
} from '../session-titles/session-title-file-reader'
import { resolveHostReadableAiVaultTitleRequests } from '../session-titles/session-title-request-paths'
import { listLocalAiVaultSubagentSessions } from './session-subagent-reader'
import {
  noteWslDistroMayHaveStopped,
  noteWslDistroWoken
} from '../../wsl/discovery/wsl-background-distro-gate'

if (!process.send) {
  throw new Error('AI Vault service requires a parent IPC channel.')
}

setActiveSink({
  push: (record) => process.send?.({ type: 'trace', record }),
  flush() {},
  close() {}
})

const controllers = new Map<number, AbortController>()
const cancelled = new Set<number>()
const pending = new Set<number>()
const titleIndex = new Map<string, CachedAiVaultSessionTitle>()
const invalidatedPaths = new Set<string>()
const sessionSearch = new SessionScannerServiceSearch(requestSessionSearchRoots)
let initialized = false
let shuttingDown = false
let cacheLane = Promise.resolve()
let interactiveLane = Promise.resolve()

function send(message: AiVaultServiceChildMessage): void {
  process.send?.(message)
}

function titleKey(request: { agent: string; sessionId: string }): string {
  return `${request.agent}\0${request.sessionId}`
}

async function executeRequest(request: AiVaultServiceRequest): Promise<AiVaultServiceResultValue> {
  const controller = new AbortController()
  controllers.set(request.id, controller)
  try {
    if (cancelled.delete(request.id)) {
      controller.abort()
    }
    if (sessionSearch.handles(request)) {
      return await sessionSearch.execute(request, controller.signal)
    }
    if (request.operation === 'titles') {
      const requests = await resolveHostReadableAiVaultTitleRequests(
        request.requests,
        controller.signal
      )
      return {
        operation: 'titles',
        value: await readAiVaultSessionTitlesFromFiles(requests, {
          signal: controller.signal,
          cache: {
            get: (entry) => titleIndex.get(titleKey(entry)) ?? null,
            set: (title) => cacheServiceTitle(titleIndex, title)
          }
        })
      }
    }
    if (request.operation === 'subagents') {
      return {
        operation: 'subagents',
        value: await listLocalAiVaultSubagentSessions(request.request)
      }
    }
    if (request.operation === 'firstPrompt') {
      return {
        operation: 'firstPrompt',
        value: await readAiVaultFirstUserPrompt(request.request)
      }
    }
    const startedAt = performance.now()
    const { result, work } = await scanReportingProgress(request, controller.signal)
    for (const session of result.sessions) {
      if ((session.agent === 'claude' || session.agent === 'codex') && session.title.trim()) {
        cacheServiceTitle(titleIndex, {
          agent: session.agent,
          sessionId: session.sessionId,
          title: session.title.trim(),
          ...(session.titleKind
            ? { kind: session.titleKind }
            : { transcriptPath: session.filePath })
        })
      }
    }
    return {
      operation: 'scan',
      value: { result, durationMs: performance.now() - startedAt, work }
    }
  } finally {
    controllers.delete(request.id)
    cancelled.delete(request.id)
    for (const path of invalidatedPaths) {
      invalidateSessionParseCacheEntry(path)
    }
    // Stop re-evicting paths once every read that could overlap the invalidation has finished.
    if (controllers.size === 0) {
      invalidatedPaths.clear()
    }
  }
}

async function handleRequest(request: AiVaultServiceRequest): Promise<void> {
  try {
    const value = await executeRequest(request)
    send({ type: 'result', id: request.id, ...value })
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
      retryable: true
    })
  } finally {
    pending.delete(request.id)
    clearServiceScanRowInterest(request.id)
  }
}

function queueRequest(request: AiVaultServiceRequest): void {
  if (pending.size >= 16) {
    send({
      type: 'error',
      id: request.id,
      message: 'AI Vault service queue is full.',
      retryable: true
    })
    return
  }
  pending.add(request.id)
  if (request.operation === 'scan') {
    setServiceScanRowInterest(request.id, request.options.streamRows === true)
  }
  // Why: search deadlines and cancellation start at admission, independent of the interactive lane.
  if (sessionSearch.handles(request)) {
    void handleRequest(request)
    return
  }
  if (aiVaultServiceLane(request.operation) === 'interactive') {
    interactiveLane = interactiveLane.then(() => handleRequest(request))
    return
  }
  cacheLane = cacheLane.then(() => handleRequest(request))
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const controller of controllers.values()) {
    controller.abort()
  }
  await sessionSearch.close()
  await Promise.allSettled([cacheLane, interactiveLane])
  await flushSessionParseCachePersist()
  process.disconnect?.()
}

process.on('message', (raw: AiVaultServiceParentMessage) => {
  if (raw?.type === 'init') {
    if (initialized || raw.protocol !== AI_VAULT_SERVICE_PROTOCOL_VERSION) {
      void shutdown()
      return
    }
    initialized = true
    if (raw.sessionParseCache) {
      initSessionParseCachePersistence(raw.sessionParseCache)
    }
    if (raw.sessionSearch) {
      sessionSearch.apply(raw.sessionSearch)
    }
    send({
      type: 'ready',
      protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
      pid: process.pid
    })
    return
  }
  if (!initialized || shuttingDown) {
    return
  }
  if (raw?.type === 'rowsInterest') {
    if (pending.has(raw.id)) {
      setServiceScanRowInterest(raw.id, raw.observed)
    }
    return
  }
  if (raw?.type === 'cancel') {
    if (!pending.has(raw.id)) {
      return
    }
    cancelled.add(raw.id)
    controllers.get(raw.id)?.abort()
    return
  }
  if (raw?.type === 'invalidate') {
    for (const path of raw.paths) {
      invalidatedPaths.delete(path)
      invalidatedPaths.add(path)
      invalidateSessionParseCacheEntry(path)
    }
    while (invalidatedPaths.size > 4_096) {
      const oldest = invalidatedPaths.values().next().value
      if (oldest === undefined) {
        break
      }
      invalidatedPaths.delete(oldest)
    }
    titleIndex.clear()
    send({ type: 'invalidated', generation: raw.generation })
    return
  }
  if (raw?.type === 'sessionSearch') {
    sessionSearch.apply(raw.init)
    return
  }
  if (raw?.type === 'shutdown') {
    void shutdown()
    return
  }
  if (raw?.type === 'wslDistroNote' && typeof raw.distro === 'string') {
    if (raw.kind === 'stopped') {
      noteWslDistroMayHaveStopped(raw.distro)
    } else {
      noteWslDistroWoken(raw.distro)
    }
    return
  }
  if (isAiVaultServiceRequest(raw)) {
    queueRequest(raw)
  }
})

process.on('disconnect', () => void shutdown())
