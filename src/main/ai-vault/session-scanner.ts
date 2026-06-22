import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { sessionSortTime } from './session-scanner-accumulator'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import {
  DEFAULT_CODEX_HOME_DIR,
  discoverAiVaultSessionSources
} from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionParseResult
} from './session-scanner-types'
import { clampPositiveInteger, errorMessage } from './session-scanner-values'

const DEFAULT_LIMIT = 1000
const DEFAULT_SCAN_LIMIT_PER_AGENT = 1000
const SESSION_PARSE_CONCURRENCY = 8

export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT)
  const limitPerAgent = clampPositiveInteger(options.limitPerAgent, DEFAULT_SCAN_LIMIT_PER_AGENT)
  const platform = options.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []
  const discoveries = await discoverAiVaultSessionSources({ options, limitPerAgent, issues })

  const candidates = discoveries
    .flatMap((discovery) =>
      discovery.files.map(
        (file): SessionFileCandidate => ({
          agent: discovery.agent,
          file,
          codexHome:
            discovery.agent === 'codex'
              ? codexHomeForSessionsDir(discovery.rootDir, DEFAULT_CODEX_HOME_DIR)
              : null
        })
      )
    )
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)

  const parsedSessions = await parseSessionCandidates({
    candidates,
    limit,
    platform,
    issues
  })

  const sessions = parsedSessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, limit)

  return {
    sessions,
    issues,
    scannedAt: new Date().toISOString()
  }
}

async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession[]> {
  const sessions: AiVaultSession[] = []
  let index = 0

  while (index < args.candidates.length) {
    if (canStopParsingSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.length, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map((candidate) => parseSessionCandidate(candidate, args.platform))
    )

    for (const result of results) {
      if (result.issue) {
        args.issues.push(result.issue)
      }
      if (result.session) {
        sessions.push(result.session)
      }
    }

    index += batchSize
  }

  return sessions
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform
): Promise<SessionParseResult> {
  try {
    const session = await parseAgentSessionFile(candidate, platform)
    return { session, issue: null }
  } catch (err) {
    return {
      session: null,
      issue: {
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

function canStopParsingSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtime is already our discovery bound and fallback sort key; older
  // files cannot displace the current visible set once the cutoff is newer.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}
