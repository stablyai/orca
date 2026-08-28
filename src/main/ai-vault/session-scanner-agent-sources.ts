import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultDeletableAgent } from '../../shared/ai-vault-session-deletion'
import { resolveGrokSessionsDir } from '../../shared/grok-session-paths'
import { uniqueCodexSessionsDirs } from './session-scanner-codex-paths'
import {
  clineMessagesPathForMetadata,
  isClineSessionMetadataPath
} from './session-scanner-cline-parser'
import { resolveKimiSessionsDir } from './session-scanner-kimi-paths'
import { OMP_SESSION_ARTIFACT_DIR_PATTERN } from './session-scanner-omp-subagent-transcripts'
import { claudeProjectsRootDirs, OMP_SESSIONS_DIR, sessionRootDirs } from './session-scanner-roots'
import { SUBAGENT_DIR_NAME } from './session-scanner-subagent-transcripts'
import type { AiVaultScanOptions } from './session-scanner-types'
import { normalizeAgentSessionsDir, primeAgentSessionsDirFromEnv } from './session-scanner-values'

export const DEFAULT_CODEX_HOME_DIR = join(homedir(), '.codex')
const CODEX_SESSIONS_DIR = join(
  process.env.CODEX_HOME?.trim() || DEFAULT_CODEX_HOME_DIR,
  'sessions'
)
const GEMINI_SESSIONS_DIR = join(homedir(), '.gemini', 'tmp')
const COPILOT_SESSIONS_DIR = join(
  process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'),
  'session-state'
)
const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects')
const HERMES_SESSIONS_DIR = join(homedir(), '.hermes', 'sessions')
const ROVO_SESSIONS_DIR = join(homedir(), '.rovodev', 'sessions')
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw')
const PI_SESSIONS_DIR = normalizeAgentSessionsDir(
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions'),
  '.pi'
)
// Why: Prime Agent brands Pi's env contract with its own prefix and adds a
// dedicated sessions-root override, so resolution differs from Pi/OMP in shape
// as well as in variable name.
const PRIME_AGENT_SESSIONS_DIR = primeAgentSessionsDirFromEnv()
// Why: Devin ATIF transcripts are stored under <DEVIN_HOME>/transcripts.
const DEVIN_TRANSCRIPTS_DIR = join(
  process.env.DEVIN_HOME?.trim() || join(homedir(), '.local', 'share', 'devin', 'cli'),
  'transcripts'
)
const DROID_SESSIONS_DIR = join(homedir(), '.factory', 'sessions')
const DROID_PROJECTS_DIR = join(homedir(), '.factory', 'projects')
const CLINE_SESSIONS_DIR =
  process.env.CLINE_SESSION_DATA_DIR?.trim() || join(homedir(), '.cline', 'data', 'sessions')

/**
 * Where one agent's session files live and which of them count as sessions.
 *
 * The scanner walks these roots to list sessions; the delete validator accepts
 * only paths this same shape would have surfaced. Both read this one table, so
 * "deletable" and "discoverable" cannot drift apart.
 */
export type AiVaultAgentSource = {
  // A function, not a value: grok resolves its root lazily because a
  // module-scope call binds across chunks at init time and breaks on bundle
  // ordering. Returns the local host root plus one per WSL distro home.
  rootDirs: (options: AiVaultScanOptions, wslHomeDirs: readonly string[]) => string[]
  extensions: readonly string[]
  filePredicate?: (filePath: string) => boolean
  // A sibling whose stat participates in candidate freshness and recency.
  contentDependencyPath?: (filePath: string) => string
  // Return false to skip a directory; depth 0 is a child of the root.
  directoryPredicate?: (name: string, depth: number) => boolean
  // Roots that are alternates for one install rather than distinct locations,
  // so the per-agent limit applies across them rather than to each.
  mergeRootDiscoveries?: boolean
}

// Every deletable agent needs an entry — the delete validator derives its roots
// and its accept rule from this table alone, so adding an agent to
// AI_VAULT_DELETABLE_AGENTS without a source here is a type error.
type AiVaultAgentSourceTable = Record<AiVaultDeletableAgent, AiVaultAgentSource> &
  Partial<Record<AiVaultAgent, AiVaultAgentSource>>

// Agents absent from this table are discovered by shape-specific scanners
// instead: opencode (SQLite plus legacy files) and antigravity (brain dirs).
export const AI_VAULT_AGENT_SOURCES: AiVaultAgentSourceTable = {
  claude: {
    rootDirs: (options, wslHomeDirs) =>
      claudeProjectsRootDirs({ claudeProjectsDir: options.claudeProjectsDir, wslHomeDirs }),
    extensions: ['.jsonl'],
    // Why: Task subagent transcripts under `<session>/subagents/` share the parent
    // sessionId and aren't independently resumable, so they'd just duplicate the
    // parent as untitled rows; prune the subtree and read them on demand under
    // their parent instead.
    directoryPredicate: (name) => name !== SUBAGENT_DIR_NAME
  },
  codex: {
    rootDirs: (options, wslHomeDirs) =>
      uniqueCodexSessionsDirs([
        options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
        ...wslHomeDirs.map((homeDir) => join(homeDir, '.codex', 'sessions')),
        // Why: Orca-launched WSL Codex sessions use an Orca-owned CODEX_HOME,
        // not the user's default ~/.codex history root.
        ...wslHomeDirs.map((homeDir) =>
          join(homeDir, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions')
        ),
        ...(options.additionalCodexSessionsDirs ?? [])
      ]),
    extensions: ['.jsonl']
  },
  gemini: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.geminiSessionsDir ?? GEMINI_SESSIONS_DIR, wslHomeDirs, [
        '.gemini',
        'tmp'
      ]),
    extensions: ['.json', '.jsonl']
  },
  copilot: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.copilotSessionsDir ?? COPILOT_SESSIONS_DIR, wslHomeDirs, [
        '.copilot',
        'session-state'
      ]),
    extensions: ['.jsonl']
  },
  cursor: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.cursorProjectsDir ?? CURSOR_PROJECTS_DIR, wslHomeDirs, [
        '.cursor',
        'projects'
      ]),
    extensions: ['.jsonl'],
    filePredicate: (filePath) => pathSegments(filePath).includes('agent-transcripts')
  },
  grok: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.grokSessionsDir ?? resolveGrokSessionsDir(), wslHomeDirs, [
        '.grok',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: (filePath) => basename(filePath) === 'summary.json'
  },
  devin: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.devinTranscriptsDir ?? DEVIN_TRANSCRIPTS_DIR, wslHomeDirs, [
        '.local',
        'share',
        'devin',
        'cli',
        'transcripts'
      ]),
    extensions: ['.json']
  },
  hermes: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.hermesSessionsDir ?? HERMES_SESSIONS_DIR, wslHomeDirs, [
        '.hermes',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: (filePath) => basename(filePath).startsWith('session_')
  },
  rovo: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.rovoSessionsDir ?? ROVO_SESSIONS_DIR, wslHomeDirs, [
        '.rovodev',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: (filePath) => basename(filePath) === 'metadata.json'
  },
  pi: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.piSessionsDir ?? PI_SESSIONS_DIR, wslHomeDirs, [
        '.pi',
        'agent',
        'sessions'
      ]),
    extensions: ['.jsonl']
  },
  omp: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.ompSessionsDir ?? OMP_SESSIONS_DIR, wslHomeDirs, [
        '.omp',
        'agent',
        'sessions'
      ]),
    extensions: ['.jsonl'],
    // Why: task subagent transcripts live inside the session's same-named
    // artifact directory (`<stamp>_<uuid>/`); surfaced as top-level rows they
    // drown coordinators under their own workers (#9330). Prune the subtree
    // and read them on demand under their parent instead. Unlike Claude's,
    // these carry their own sessionId and would resume by path — but OMP's
    // own picker only globs `*/*.jsonl`, so it never offers them either.
    // Depth 0 is the workspace dir, which is never an artifact dir.
    directoryPredicate: (name, depth) => depth === 0 || !OMP_SESSION_ARTIFACT_DIR_PATTERN.test(name)
  },
  'prime-agent': {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.primeAgentSessionsDir ?? PRIME_AGENT_SESSIONS_DIR, wslHomeDirs, [
        '.prime',
        'agent',
        'sessions'
      ]),
    extensions: ['.jsonl']
  },
  openclaw: {
    // Sessions live under <stateDir>/agents; a stateDir already ending in
    // `agents` is used as-is. The current and legacy state dirs are the same
    // install, so their discoveries merge.
    rootDirs: (options, wslHomeDirs) =>
      [
        options.openclawStateDir ?? OPENCLAW_STATE_DIR,
        options.openclawLegacyStateDir ?? join(homedir(), '.clawdbot'),
        ...wslHomeDirs.map((homeDir) => join(homeDir, '.openclaw')),
        ...wslHomeDirs.map((homeDir) => join(homeDir, '.clawdbot'))
      ].map((stateDir) => (basename(stateDir) === 'agents' ? stateDir : join(stateDir, 'agents'))),
    extensions: ['.jsonl'],
    filePredicate: (filePath) => pathSegments(filePath).includes('sessions'),
    mergeRootDiscoveries: true
  },
  droid: {
    rootDirs: (options, wslHomeDirs) => [
      ...sessionRootDirs(options.droidSessionsDir ?? DROID_SESSIONS_DIR, wslHomeDirs, [
        '.factory',
        'sessions'
      ]),
      ...sessionRootDirs(options.droidProjectsDir ?? DROID_PROJECTS_DIR, wslHomeDirs, [
        '.factory',
        'projects'
      ])
    ],
    extensions: ['.jsonl']
  },
  cline: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.clineSessionsDir ?? CLINE_SESSIONS_DIR, wslHomeDirs, [
        '.cline',
        'data',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: isClineSessionMetadataPath,
    contentDependencyPath: clineMessagesPathForMetadata,
    // Cline stores one manifest directly beneath each session directory.
    directoryPredicate: (_name, depth) => depth === 0
  },
  kimi: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(resolveKimiSessionsDir(options.kimiSessionsDir), wslHomeDirs, [
        '.kimi-code',
        'sessions'
      ]),
    extensions: ['.json'],
    // Why: each Kimi session is <sessions>/wd_*/session_*/state.json; match
    // only those (not the sibling agents/*/wire.jsonl transcripts).
    filePredicate: (filePath) =>
      basename(filePath) === 'state.json' && basename(dirname(filePath)).startsWith('session_')
  }
}

/**
 * Whether a scan rooted at `rootDir` would surface `filePath`: its extension,
 * its file predicate, and every directory between the two passing the directory
 * predicate. This is the delete validator's accept rule, so a path no scan
 * would ever list can't become a delete target either.
 */
export function isDiscoverableSessionFile(
  source: AiVaultAgentSource,
  rootDir: string,
  filePath: string
): boolean {
  if (!source.extensions.includes(extname(filePath).toLowerCase())) {
    return false
  }
  if (source.filePredicate && !source.filePredicate(filePath)) {
    return false
  }
  const { directoryPredicate } = source
  if (!directoryPredicate) {
    return true
  }
  // Indexed like walkSessionFiles: depth 0 is a child of rootDir.
  return pathSegments(relative(rootDir, dirname(filePath)))
    .filter(Boolean)
    .every((name, depth) => directoryPredicate(name, depth))
}

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/)
}
