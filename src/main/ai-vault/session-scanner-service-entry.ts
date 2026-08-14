import type { AiVaultSessionTitle } from '../../shared/ai-vault-session-title'
import { readAiVaultFirstUserPrompt } from './session-first-user-prompt-read'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence
} from './session-parse-cache-persistence'
import { scanAiVaultSessions } from './session-scanner'
import { invalidateSessionParseCacheEntry } from './session-scanner-parse-cache'
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
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'
import { resolveHostReadableAiVaultTitleRequests } from './session-title-request-paths'
import { listLocalAiVaultSubagentSessions } from './session-subagent-reader'

if (!process.send) {
  throw new Error('AI Vault service requires a parent IPC channel.')
}

const controllers = new Map<number, AbortController>()
const cancelled = new Set<number>()
const pending = new Set<number>()
const titleIndex = new Map<string, AiVaultSessionTitle>()
const invalidatedPaths = new Set<string>()
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
    const result = await scanAiVaultSessions({ ...request.options, signal: controller.signal })
    for (const session of result.sessions) {
      if ((session.agent === 'claude' || session.agent === 'codex') && session.title.trim()) {
        cacheServiceTitle(titleIndex, {
          agent: session.agent,
          sessionId: session.sessionId,
          title: session.title.trim()
        })
      }
    }
    return {
      operation: 'scan',
      value: { result, durationMs: performance.now() - startedAt }
    }
  } finally {
    controllers.delete(request.id)
    cancelled.delete(request.id)
    for (const path of invalidatedPaths) {
      invalidateSessionParseCacheEntry(path)
    }
    // Why: the re-apply only protects reads that overlapped the invalidation.
    // Once nothing else is executing it has done its job, and holding the paths
    // would re-evict them on every later request for the life of the process.
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
    send({ type: 'ready', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION, pid: process.pid })
    return
  }
  if (!initialized || shuttingDown) {
    return
  }
  if (raw?.type === 'cancel') {
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
  if (raw?.type === 'shutdown') {
    void shutdown()
    return
  }
  if (isAiVaultServiceRequest(raw)) {
    queueRequest(raw)
  }
})

process.on('disconnect', () => void shutdown())
