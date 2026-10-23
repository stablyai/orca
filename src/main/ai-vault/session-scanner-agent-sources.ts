import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathSegments } from './session-file-discovery'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultDeletableAgent } from '../../shared/ai-vault-session-deletion'
import { resolveGrokSessionsDir } from '../../shared/grok-session-paths'
import { resolveKiroHomeDir } from '../../shared/kiro-home'
import { uniqueCodexSessionsDirs } from './session-scanner-codex-paths'
import {
  clineMessagesPathForMetadata,
  isClineSessionMetadataPath
} from './session-scanner-cline-parser'
import { cursorChatMetaPath } from './session-scanner-cursor-chat-meta'
import { devinSessionsDbDependencyPath } from './session-scanner-devin-db'
import { resolveKimiSessionsDir } from './session-scanner-kimi-paths'
import { resolveMuseSessionsDir } from './session-scanner-muse-paths'
import {
  isKiroSessionMetadataPath,
  kiroTranscriptPathForMetadata
} from './session-scanner-kiro-parser'
import { OPENCLAW_AGENT_SOURCE } from './openclaw-session-layout'
import { OMP_SESSION_ARTIFACT_DIR_PATTERN } from './session-scanner-omp-subagent-transcripts'
import {
  claudeProjectsRootDirs,
  codexHomeSessionsDir,
  ompSessionsRootDirs,
  sessionRootDirs,
  wslHomeSessionDirs
} from './session-scanner-roots'
import { SUBAGENT_DIR_NAME } from './session-scanner-subagent-transcripts'
import type { AiVaultScanOptions } from './session-scanner-types'
import { normalizeAgentSessionsDir, primeAgentSessionsDirFromEnv } from './session-scanner-values'

export const DEFAULT_CODEX_HOME_DIR = join(homedir(), '.codex')
const GEMINI_SESSIONS_DIR = join(homedir(), '.gemini', 'tmp')
const COPILOT_SESSIONS_DIR = join(
  resolveAbsoluteDirOverride(process.env.COPILOT_HOME, join(homedir(), '.copilot')),
  'session-state'
)
const CURSOR_PROJECTS_DIR = join(homedir(), '.cursor', 'projects')
const CODEBUDDY_PROJECTS_DIR = join(homedir(), '.codebuddy', 'projects')
const HERMES_SESSIONS_DIR = join(homedir(), '.hermes', 'sessions')
const ROVO_SESSIONS_DIR = join(homedir(), '.rovodev', 'sessions')
export function piSessionHistorySessionsDir(): string {
  return normalizeAgentSessionsDir(
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions'),
    '.pi'
  )
}
const PRIME_AGENT_SESSIONS_DIR = primeAgentSessionsDirFromEnv()
const DEVIN_TRANSCRIPTS_DIR = join(
  resolveAbsoluteDirOverride(
    process.env.DEVIN_HOME,
    process.platform === 'win32'
      ? join(process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'devin', 'cli')
      : join(
          process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
          'devin',
          'cli'
        )
  ),
  'transcripts'
)
const KIRO_SESSIONS_DIR = join(resolveKiroHomeDir(), 'sessions', 'cli')
const DROID_SESSIONS_DIR = join(homedir(), '.factory', 'sessions')
const DROID_PROJECTS_DIR = join(homedir(), '.factory', 'projects')
const CLINE_SESSIONS_DIR =
  process.env.CLINE_SESSION_DATA_DIR?.trim() || join(homedir(), '.cline', 'data', 'sessions')

/** Shared discovery rules constrain which paths the delete validator accepts. */
export type AiVaultAgentSource = {
  // Resolve lazily: module-time Grok resolution breaks cross-chunk initialization ordering.
  rootDirs: (options: AiVaultScanOptions, wslHomeDirs: readonly string[]) => string[]
  extensions: readonly string[]
  filePredicate?: (filePath: string) => boolean
  // Sidecar stats affect freshness and recency; async resolution supports non-derived paths.
  contentDependencyPath?: (filePath: string) => string | undefined | Promise<string | undefined>
  // Return false to skip a directory; depth 0 is a child of the root.
  directoryPredicate?: (name: string, depth: number) => boolean
  // Share the per-agent limit across alternate roots for one install.
  mergeRootDiscoveries?: boolean
}

type AiVaultAgentSourceTable = Record<AiVaultDeletableAgent, AiVaultAgentSource> &
  Partial<Record<AiVaultAgent, AiVaultAgentSource>>

// OpenCode and Antigravity use dedicated discovery for their storage layouts.
export const AI_VAULT_AGENT_SOURCES: AiVaultAgentSourceTable = {
  claude: {
    rootDirs: (options, wslHomeDirs) =>
      claudeProjectsRootDirs({
        claudeProjectsDir: options.claudeProjectsDir,
        wslHomeDirs,
        claudeProfileProjectsDirs: options.claudeProfileProjectsDirs
      }),
    extensions: ['.jsonl'],
    // Read non-resumable task transcripts under their parent instead of duplicating History rows.
    directoryPredicate: (name) => name !== SUBAGENT_DIR_NAME
  },
  qoder: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(
        options.qoderProjectsDir ?? join(homedir(), '.qoder', 'projects'),
        wslHomeDirs,
        ['.qoder', 'projects']
      ),
    extensions: ['.jsonl'],
    directoryPredicate: (name) => name !== SUBAGENT_DIR_NAME
  },
  codebuddy: {
    rootDirs: (options, wslHomeDirs) => [
      options.codebuddyProjectsDir ?? CODEBUDDY_PROJECTS_DIR,
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.codebuddy', 'projects'))
    ],
    extensions: ['.jsonl'],
    // Nested subagent transcripts are not independent top-level conversations.
    directoryPredicate: (name) => name !== SUBAGENT_DIR_NAME
  },
  codex: {
    rootDirs: (options, wslHomeDirs) =>
      uniqueCodexSessionsDirs([
        options.codexSessionsDir ?? codexHomeSessionsDir(),
        ...wslHomeSessionDirs('codex', wslHomeDirs),
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
    filePredicate: (filePath) => pathSegments(filePath).includes('agent-transcripts'),
    contentDependencyPath: cursorChatMetaPath
  },
  grok: {
    rootDirs: (options, wslHomeDirs) => [
      options.grokSessionsDir ?? resolveGrokSessionsDir(),
      ...wslHomeSessionDirs('grok', wslHomeDirs)
    ],
    extensions: ['.json'],
    filePredicate: (filePath) => basename(filePath) === 'summary.json'
  },
  devin: {
    rootDirs: (options, wslHomeDirs) => [
      ...sessionRootDirs(options.devinTranscriptsDir ?? DEVIN_TRANSCRIPTS_DIR, wslHomeDirs, [
        '.local',
        'share',
        'devin',
        'cli',
        'transcripts'
      ]),
      // Devin 3000.10.31 exports ATIF to agent_logs by default.
      ...(options.devinTranscriptsDir ? [] : [join(dirname(DEVIN_TRANSCRIPTS_DIR), 'agent_logs')]),
      ...wslHomeDirs.map((homeDir) =>
        join(homeDir, '.local', 'share', 'devin', 'cli', 'agent_logs')
      )
    ],
    mergeRootDiscoveries: true,
    extensions: ['.json'],
    // Database-only title or visibility changes must refresh sessions without rereading transcripts.
    contentDependencyPath: devinSessionsDbDependencyPath
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
  jcode: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(
        options.jcodeSessionsDir ??
          join(process.env.JCODE_HOME?.trim() || join(homedir(), '.jcode'), 'sessions'),
        wslHomeDirs,
        ['.jcode', 'sessions']
      ),
    extensions: ['.json'],
    // Exclude live journals and consolidated backups.
    filePredicate: (filePath) => basename(filePath).startsWith('session_')
  },
  kiro: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.kiroSessionsDir ?? KIRO_SESSIONS_DIR, wslHomeDirs, [
        '.kiro',
        'sessions',
        'cli'
      ]),
    extensions: ['.json'],
    filePredicate: isKiroSessionMetadataPath,
    // Transcript appends must invalidate the cached metadata row.
    contentDependencyPath: kiroTranscriptPathForMetadata,
    // Per-session subdirectories hold background task state, not sessions.
    directoryPredicate: () => false
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
      sessionRootDirs(options.piSessionsDir ?? piSessionHistorySessionsDir(), wslHomeDirs, [
        '.pi',
        'agent',
        'sessions'
      ]),
    extensions: ['.jsonl']
  },
  omp: {
    rootDirs: (options, wslHomeDirs) =>
      ompSessionsRootDirs({ ompSessionsDir: options.ompSessionsDir, wslHomeDirs }),
    extensions: ['.jsonl'],
    // Skip worker artifacts below workspace depth; OMP lists only top-level conversations (#9330).
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
  openclaw: OPENCLAW_AGENT_SOURCE,
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
    // Match session state files rather than sibling agent wire transcripts.
    filePredicate: (filePath) =>
      basename(filePath) === 'state.json' && basename(dirname(filePath)).startsWith('session_')
  },
  muse: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(resolveMuseSessionsDir(options.museSessionsDir), wslHomeDirs, [
        '.local',
        'share',
        'muse',
        'sessions'
      ]),
    extensions: ['.jsonl'],
    // Exclude log, SQLite and materialized-projection sidecars.
    filePredicate: (filePath) => basename(filePath) === 'session.jsonl'
  }
}

export { isDiscoverableSessionFile } from './session-file-discovery'
