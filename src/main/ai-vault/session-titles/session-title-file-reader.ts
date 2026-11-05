import { wslGatedLstat } from '../../native-chat/wsl-transcript-fs-access'
import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitle,
  type AiVaultSessionTitleRequest,
  type AiVaultSessionTitlesResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-title'
import { parseAgentSessionFileCached } from '../parse-cache/session-scanner-parse-cache'

import {
  codexHomeFromSessionFilePath,
  readCodexSessionIndexTitles,
  withCodexSessionIndexTitles
} from '../scanners/codex/session-scanner-codex-title-index'

const TITLE_PARSE_CONCURRENCY = 4

export type AiVaultSessionTitleCache = {
  get(request: AiVaultSessionTitleRequest): AiVaultSessionTitle | null
  set(title: AiVaultSessionTitle): void
}

async function readOneTitle(
  request: AiVaultSessionTitleRequest,
  signal: AbortSignal | undefined,
  cache?: AiVaultSessionTitleCache
): Promise<AiVaultSessionTitle | null> {
  if (signal?.aborted) {
    return null
  }
  const transcriptPath = request.transcriptPath?.trim()
  if (!transcriptPath) {
    return cache?.get(request) ?? null
  }
  try {
    const home = request.agent === 'codex' ? codexHomeFromSessionFilePath(transcriptPath) : null
    if (home) {
      const title = (await readCodexSessionIndexTitles(home)).get(request.sessionId)
      if (signal?.aborted) {
        return null
      }
      if (title) {
        const resolved = { agent: request.agent, sessionId: request.sessionId, title }
        cache?.set(resolved)
        return resolved
      }
    }
    const stats = await wslGatedLstat(transcriptPath, 'scan', signal)
    if (!stats.isFile() || signal?.aborted) {
      return null
    }
    // Raw lstat matches scanner keys only for providers without content dependencies: Claude and Codex.
    const session = await parseAgentSessionFileCached(
      {
        agent: request.agent,
        file: {
          path: transcriptPath,
          mtimeMs: stats.mtimeMs,
          modifiedAt: stats.mtime.toISOString(),
          sizeBytes: stats.size
        },
        codexHome: null
      },
      process.platform,
      undefined,
      undefined,
      signal
    )
    if (
      signal?.aborted ||
      session?.agent !== request.agent ||
      session.sessionId !== request.sessionId ||
      !session.title.trim()
    ) {
      return null
    }
    const title = {
      agent: request.agent,
      sessionId: request.sessionId,
      title: session.title.trim()
    }
    cache?.set(title)
    return title
  } catch {
    return null
  }
}

export function readAiVaultSessionTitlesFromFiles(
  requests: AiVaultSessionTitleRequest[],
  options: { cache?: AiVaultSessionTitleCache; signal?: AbortSignal } = {}
): Promise<AiVaultSessionTitlesResult> {
  return withCodexSessionIndexTitles(() => readSessionTitles(requests, options))
}

async function readSessionTitles(
  requests: AiVaultSessionTitleRequest[],
  options: { cache?: AiVaultSessionTitleCache; signal?: AbortSignal } = {}
): Promise<AiVaultSessionTitlesResult> {
  const bounded = requests.slice(0, AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)
  const resolved: (AiVaultSessionTitle | null)[] = Array.from(
    { length: bounded.length },
    () => null
  )
  let nextIndex = 0
  const parseNext = async (): Promise<void> => {
    while (nextIndex < bounded.length && !options.signal?.aborted) {
      const index = nextIndex++
      resolved[index] = await readOneTitle(bounded[index]!, options.signal, options.cache)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TITLE_PARSE_CONCURRENCY, bounded.length) }, parseNext)
  )
  return { titles: resolved.filter((title): title is AiVaultSessionTitle => title !== null) }
}
