import { wslGatedLstat } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
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

/** A title the scanner already saw, with its transcript when the title's kind is not known yet. */
export type CachedAiVaultSessionTitle = AiVaultSessionTitle & { transcriptPath?: string }

export type AiVaultSessionTitleCache = {
  get(request: AiVaultSessionTitleRequest): CachedAiVaultSessionTitle | null
  set(title: CachedAiVaultSessionTitle): void
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
    const cached = cache?.get(request)
    if (!cached) {
      return null
    }
    const { transcriptPath: cachedPath, ...title } = cached
    // Why: History caches titles from parse rows saved before titles carried a kind; reading that
    // transcript here classifies it once (the result replaces the cached entry, so this cannot repeat).
    // A failed reread (a stalled WSL distro) still returns the cached title, unclassified.
    return !title.kind && cachedPath
      ? ((await readOneTitle({ ...request, transcriptPath: cachedPath }, signal, cache)) ?? title)
      : title
  }
  try {
    const home = request.agent === 'codex' ? codexHomeFromSessionFilePath(transcriptPath) : null
    if (home) {
      const title = (await readCodexSessionIndexTitles(home)).get(request.sessionId)
      if (signal?.aborted) {
        return null
      }
      if (title) {
        const resolved: AiVaultSessionTitle = {
          agent: request.agent,
          sessionId: request.sessionId,
          title,
          kind: 'named'
        }
        cache?.set(resolved)
        return resolved
      }
    }
    const stats = await wslGatedLstat(transcriptPath, 'scan', signal)
    if (!stats.isFile() || signal?.aborted) {
      return null
    }
    // Raw lstat matches scanner keys only for providers without content dependencies: Claude and Codex.
    const candidate = {
      agent: request.agent,
      file: {
        path: transcriptPath,
        mtimeMs: stats.mtimeMs,
        modifiedAt: stats.mtime.toISOString(),
        sizeBytes: stats.size
      },
      codexHome: null
    }
    let session = await parseAgentSessionFileCached(
      candidate,
      process.platform,
      undefined,
      undefined,
      signal
    )
    // Why: entries cached before titles carried their kind would rank every name as a stand-in; reread
    // such a transcript once so the cache learns the kind, instead of invalidating every cached session.
    if (
      session?.agent === request.agent &&
      session.sessionId === request.sessionId &&
      !session.titleKind &&
      !signal?.aborted
    ) {
      // A failed reread keeps the first result, unclassified.
      session =
        (await parseAgentSessionFileCached(
          candidate,
          process.platform,
          undefined,
          'whole',
          signal
        ).catch(() => null)) ?? session
    }
    if (
      signal?.aborted ||
      session?.agent !== request.agent ||
      session.sessionId !== request.sessionId ||
      !session.title.trim()
    ) {
      return null
    }
    const title: AiVaultSessionTitle = {
      agent: request.agent,
      sessionId: request.sessionId,
      title: session.title.trim(),
      ...(session.titleKind ? { kind: session.titleKind } : {})
    }
    // An unclassified title keeps its transcript so a later session-id-only request can still classify it.
    cache?.set(title.kind ? title : { ...title, transcriptPath })
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
