import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { sessionSortTime } from './session-scanner-accumulator'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { codexHomeForSessionsDir, uniqueCodexSessionsDirs } from './session-scanner-codex-paths'
import { discoverFiles, discoverOpenClawFiles } from './session-scanner-discovery'
import { resolveKimiSessionsDir } from './session-scanner-kimi-paths'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery,
  SessionParseResult
} from './session-scanner-types'
import {
  clampPositiveInteger,
  errorMessage,
  normalizePiSessionsDir
} from './session-scanner-values'

const DEFAULT_LIMIT = 1000
const DEFAULT_SCAN_LIMIT_PER_AGENT = 1000
const SESSION_PARSE_CONCURRENCY = 8
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const DEFAULT_CODEX_HOME_DIR = join(homedir(), '.codex')
const CODEX_HOME_DIR = process.env.CODEX_HOME?.trim() || DEFAULT_CODEX_HOME_DIR
const CODEX_SESSIONS_DIR = join(CODEX_HOME_DIR, 'sessions')
const GEMINI_SESSIONS_DIR = join(homedir(), '.gemini', 'tmp')
const COPILOT_SESSIONS_DIR = join(
  process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'),
  'session-state'
)
const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects')
const OPENCODE_STORAGE_DIR = join(
  process.env.OPENCODE_CONFIG_DIR?.trim() || join(homedir(), '.local', 'share', 'opencode'),
  'storage'
)
const GROK_SESSIONS_DIR = join(
  process.env.GROK_HOME?.trim() || join(homedir(), '.grok'),
  'sessions'
)
const HERMES_SESSIONS_DIR = join(homedir(), '.hermes', 'sessions')
const ROVO_SESSIONS_DIR = join(homedir(), '.rovodev', 'sessions')
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw')
const PI_SESSIONS_DIR = normalizePiSessionsDir(
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions')
)
const DROID_SESSIONS_DIR = join(homedir(), '.factory', 'sessions')
// Why: Devin ATIF transcripts are stored under <DEVIN_HOME>/transcripts.
const DEVIN_TRANSCRIPTS_DIR = join(
  process.env.DEVIN_HOME?.trim() || join(homedir(), '.local', 'share', 'devin', 'cli'),
  'transcripts'
)

export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT)
  const limitPerAgent = clampPositiveInteger(options.limitPerAgent, DEFAULT_SCAN_LIMIT_PER_AGENT)
  const platform = options.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []
  const codexSessionsDirs = uniqueCodexSessionsDirs([
    options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
    ...(options.additionalCodexSessionsDirs ?? [])
  ])

  const discoveries = await Promise.all<SessionFileDiscovery>([
    discoverFiles({
      rootDir: options.claudeProjectsDir ?? CLAUDE_PROJECTS_DIR,
      limit: limitPerAgent,
      agent: 'claude',
      issues,
      extensions: ['.jsonl']
    }),
    ...codexSessionsDirs.map((rootDir) =>
      discoverFiles({
        rootDir,
        limit: limitPerAgent,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })
    ),
    discoverFiles({
      rootDir: options.geminiSessionsDir ?? GEMINI_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'gemini',
      issues,
      extensions: ['.json', '.jsonl']
    }),
    discoverFiles({
      rootDir: options.copilotSessionsDir ?? COPILOT_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'copilot',
      issues,
      extensions: ['.jsonl']
    }),
    discoverFiles({
      rootDir: options.cursorProjectsDir ?? CURSOR_PROJECTS_DIR,
      limit: limitPerAgent,
      agent: 'cursor',
      issues,
      extensions: ['.jsonl'],
      filePredicate: (path) => path.split(/[\\/]/).includes('agent-transcripts')
    }),
    discoverFiles({
      rootDir: join(options.opencodeStorageDir ?? OPENCODE_STORAGE_DIR, 'session'),
      limit: limitPerAgent,
      agent: 'opencode',
      issues,
      extensions: ['.json']
    }),
    discoverFiles({
      rootDir: options.grokSessionsDir ?? GROK_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'grok',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path) === 'summary.json'
    }),
    discoverFiles({
      rootDir: options.devinTranscriptsDir ?? DEVIN_TRANSCRIPTS_DIR,
      limit: limitPerAgent,
      agent: 'devin',
      issues,
      extensions: ['.json']
    }),
    discoverFiles({
      rootDir: options.hermesSessionsDir ?? HERMES_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'hermes',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path).startsWith('session_')
    }),
    discoverFiles({
      rootDir: options.rovoSessionsDir ?? ROVO_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'rovo',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path) === 'metadata.json'
    }),
    discoverOpenClawFiles({
      rootDirs: [
        options.openclawStateDir ?? OPENCLAW_STATE_DIR,
        options.openclawLegacyStateDir ?? join(homedir(), '.clawdbot')
      ],
      limit: limitPerAgent,
      issues
    }),
    discoverFiles({
      rootDir: options.piSessionsDir ?? PI_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'pi',
      issues,
      extensions: ['.jsonl']
    }),
    discoverFiles({
      rootDir: options.droidSessionsDir ?? DROID_SESSIONS_DIR,
      limit: limitPerAgent,
      agent: 'droid',
      issues,
      extensions: ['.jsonl']
    }),
    discoverFiles({
      rootDir: options.droidProjectsDir ?? join(homedir(), '.factory', 'projects'),
      limit: limitPerAgent,
      agent: 'droid',
      issues,
      extensions: ['.jsonl']
    }),
    discoverFiles({
      rootDir: resolveKimiSessionsDir(options.kimiSessionsDir),
      limit: limitPerAgent,
      agent: 'kimi',
      issues,
      extensions: ['.json'],
      // Why: each Kimi session is <sessions>/wd_*/session_*/state.json; match
      // only those (not the sibling agents/*/wire.jsonl transcripts).
      filePredicate: (path) =>
        basename(path) === 'state.json' && basename(dirname(path)).startsWith('session_')
    })
  ])

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
