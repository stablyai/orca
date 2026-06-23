import { homedir } from 'os'
import { basename, join } from 'path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { uniqueCodexSessionsDirs } from './session-scanner-codex-paths'
import { discoverFiles, discoverOpenClawFiles } from './session-scanner-discovery'
import { droidDiscoveries, kimiDiscoveries } from './session-scanner-droid-kimi-sources'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'
import { normalizePiSessionsDir } from './session-scanner-values'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
export const DEFAULT_CODEX_HOME_DIR = join(homedir(), '.codex')
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
// Why: Devin ATIF transcripts are stored under <DEVIN_HOME>/transcripts.
const DEVIN_TRANSCRIPTS_DIR = join(
  process.env.DEVIN_HOME?.trim() || join(homedir(), '.local', 'share', 'devin', 'cli'),
  'transcripts'
)

export async function discoverAiVaultSessionSources(args: {
  options: AiVaultScanOptions
  limitPerAgent: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery[]> {
  const { options, limitPerAgent, issues } = args
  const wslHomeDirs = normalizedWslHomeDirs(options.wslHomeDirs)
  const codexSessionsDirs = uniqueCodexSessionsDirs([
    options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.codex', 'sessions')),
    // Why: Orca-launched WSL Codex sessions use an Orca-owned CODEX_HOME,
    // not the user's default ~/.codex history root.
    ...wslHomeDirs.map((homeDir) =>
      join(homeDir, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions')
    ),
    ...(options.additionalCodexSessionsDirs ?? [])
  ])

  return Promise.all<SessionFileDiscovery>([
    ...claudeDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...codexDiscoveries(codexSessionsDirs, limitPerAgent, issues),
    ...standardDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    openClawDiscovery(options, wslHomeDirs, limitPerAgent, issues),
    ...droidDiscoveries(options, wslHomeDirs, limitPerAgent, issues),
    ...kimiDiscoveries(options, wslHomeDirs, limitPerAgent, issues)
  ])
}

function claudeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return [
    options.claudeProjectsDir ?? CLAUDE_PROJECTS_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.claude', 'projects'))
  ].map((rootDir) =>
    discoverFiles({ rootDir, limit, agent: 'claude', issues, extensions: ['.jsonl'] })
  )
}

function codexDiscoveries(
  rootDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return rootDirs.map((rootDir) =>
    discoverFiles({ rootDir, limit, agent: 'codex', issues, extensions: ['.jsonl'] })
  )
}

function standardDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return [
    ...sessionRootDirs(options.geminiSessionsDir ?? GEMINI_SESSIONS_DIR, wslHomeDirs, [
      '.gemini',
      'tmp'
    ]).map((rootDir) =>
      discoverFiles({ rootDir, limit, agent: 'gemini', issues, extensions: ['.json', '.jsonl'] })
    ),
    ...sessionRootDirs(options.copilotSessionsDir ?? COPILOT_SESSIONS_DIR, wslHomeDirs, [
      '.copilot',
      'session-state'
    ]).map((rootDir) =>
      discoverFiles({ rootDir, limit, agent: 'copilot', issues, extensions: ['.jsonl'] })
    ),
    ...cursorDiscoveries(options, wslHomeDirs, limit, issues),
    ...opencodeDiscoveries(options, wslHomeDirs, limit, issues),
    ...grokDiscoveries(options, wslHomeDirs, limit, issues),
    ...devinDiscoveries(options, wslHomeDirs, limit, issues),
    ...hermesDiscoveries(options, wslHomeDirs, limit, issues),
    ...rovoDiscoveries(options, wslHomeDirs, limit, issues),
    ...piDiscoveries(options, wslHomeDirs, limit, issues)
  ]
}

function cursorDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.cursorProjectsDir ?? CURSOR_PROJECTS_DIR, wslHomeDirs, [
    '.cursor',
    'projects'
  ]).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'cursor',
      issues,
      extensions: ['.jsonl'],
      filePredicate: (path) => path.split(/[\\/]/).includes('agent-transcripts')
    })
  )
}

function opencodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(
    join(options.opencodeStorageDir ?? OPENCODE_STORAGE_DIR, 'session'),
    wslHomeDirs,
    ['.local', 'share', 'opencode', 'storage', 'session']
  ).map((rootDir) =>
    discoverFiles({ rootDir, limit, agent: 'opencode', issues, extensions: ['.json'] })
  )
}

function grokDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.grokSessionsDir ?? GROK_SESSIONS_DIR, wslHomeDirs, [
    '.grok',
    'sessions'
  ]).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'grok',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path) === 'summary.json'
    })
  )
}

function devinDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.devinTranscriptsDir ?? DEVIN_TRANSCRIPTS_DIR, wslHomeDirs, [
    '.local',
    'share',
    'devin',
    'cli',
    'transcripts'
  ]).map((rootDir) =>
    discoverFiles({ rootDir, limit, agent: 'devin', issues, extensions: ['.json'] })
  )
}

function hermesDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.hermesSessionsDir ?? HERMES_SESSIONS_DIR, wslHomeDirs, [
    '.hermes',
    'sessions'
  ]).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'hermes',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path).startsWith('session_')
    })
  )
}

function rovoDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.rovoSessionsDir ?? ROVO_SESSIONS_DIR, wslHomeDirs, [
    '.rovodev',
    'sessions'
  ]).map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'rovo',
      issues,
      extensions: ['.json'],
      filePredicate: (path) => basename(path) === 'metadata.json'
    })
  )
}

function piDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return sessionRootDirs(options.piSessionsDir ?? PI_SESSIONS_DIR, wslHomeDirs, [
    '.pi',
    'agent',
    'sessions'
  ]).map((rootDir) =>
    discoverFiles({ rootDir, limit, agent: 'pi', issues, extensions: ['.jsonl'] })
  )
}

function openClawDiscovery(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  return discoverOpenClawFiles({
    rootDirs: [
      options.openclawStateDir ?? OPENCLAW_STATE_DIR,
      options.openclawLegacyStateDir ?? join(homedir(), '.clawdbot'),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.openclaw')),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.clawdbot'))
    ],
    limit,
    issues
  })
}

function normalizedWslHomeDirs(homeDirs: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const homeDir of homeDirs ?? []) {
    const trimmed = homeDir.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

function sessionRootDirs(
  hostRootDir: string,
  wslHomeDirs: readonly string[],
  segments: readonly string[]
): string[] {
  return [hostRootDir, ...wslHomeDirs.map((homeDir) => join(homeDir, ...segments))]
}
