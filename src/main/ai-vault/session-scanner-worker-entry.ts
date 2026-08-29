import { parentPort, workerData } from 'node:worker_threads'
import type {
  AiVaultSessionTitle,
  AiVaultSessionTitleRequest
} from '../../shared/ai-vault-session-title'
import { scanAiVaultSessions } from './session-scanner'
import { initSessionParseCachePersistence } from './session-parse-cache-persistence'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'
import { resolveHostReadableAiVaultTitleRequests } from './session-title-request-paths'
import type {
  AiVaultWorkerControl,
  AiVaultWorkerData,
  AiVaultWorkerRequest,
  AiVaultWorkerResponse
} from './session-scanner-worker-protocol'

const TITLE_INDEX_MAX_ENTRIES = 4_096

if (!parentPort) {
  throw new Error('AI Vault scanner worker must run with a parent port.')
}
const port = parentPort
const data = workerData as AiVaultWorkerData | undefined
if (data?.sessionParseCache) {
  initSessionParseCachePersistence(data.sessionParseCache)
}
const controllers = new Map<number, AbortController>()
const titleIndex = new Map<string, AiVaultSessionTitle>()

function titleKey(request: Pick<AiVaultSessionTitleRequest, 'agent' | 'sessionId'>): string {
  return `${request.agent}\0${request.sessionId}`
}

function storeTitle(title: AiVaultSessionTitle): void {
  const key = titleKey(title)
  titleIndex.delete(key)
  titleIndex.set(key, title)
  while (titleIndex.size > TITLE_INDEX_MAX_ENTRIES) {
    const oldest = titleIndex.keys().next().value
    if (oldest === undefined) {
      break
    }
    titleIndex.delete(oldest)
  }
}

async function handleRequest(request: AiVaultWorkerRequest): Promise<AiVaultWorkerResponse> {
  const controller = new AbortController()
  controllers.set(request.id, controller)
  try {
    if (request.kind === 'titles') {
      const requests = await resolveHostReadableAiVaultTitleRequests(
        request.requests,
        controller.signal
      )
      return {
        id: request.id,
        ok: true,
        kind: 'titles',
        value: await readAiVaultSessionTitlesFromFiles(requests, {
          signal: controller.signal,
          cache: {
            get: (titleRequest) => titleIndex.get(titleKey(titleRequest)) ?? null,
            set: storeTitle
          }
        })
      }
    }
    const startedAt = performance.now()
    const result = await scanAiVaultSessions({ ...request.options, signal: controller.signal })
    for (const session of result.sessions) {
      if ((session.agent === 'claude' || session.agent === 'codex') && session.title.trim()) {
        storeTitle({
          agent: session.agent,
          sessionId: session.sessionId,
          title: session.title.trim()
        })
      }
    }
    return {
      id: request.id,
      ok: true,
      kind: 'scan',
      value: { result, durationMs: performance.now() - startedAt }
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    controllers.delete(request.id)
  }
}

let pending = Promise.resolve()
port.on('message', (message: AiVaultWorkerRequest | AiVaultWorkerControl) => {
  if (message.kind === 'cancel') {
    controllers.get(message.id)?.abort()
    return
  }
  pending = pending.then(async () => {
    const response = await handleRequest(message)
    try {
      port.postMessage(response)
    } catch {
      port.postMessage({
        id: message.id,
        ok: false,
        error: 'AI Vault worker result could not be serialized.'
      } satisfies AiVaultWorkerResponse)
    }
  })
})
