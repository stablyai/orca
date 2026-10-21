import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  resolveClaudeGlobalConfigFile,
  updateClaudeGlobalConfig
} from '../claude/claude-folder-trust-file'
import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { publishFileWithoutOverwrite } from '../codex-accounts/fs-utils'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'
import { readClaudeProfileObject, resolveClaudeDefaultHome } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import { copyClaudeProfileFile, linkClaudeProfileDirectory } from './claude-profile-sharing'

const CLAUDE_PROFILE_MEMORY_IMPORT = '@~/.claude/CLAUDE.md\n'

/**
 * Mirrors the list Claude itself leaves out when it seeds a fresh config folder from ~/.claude
 * (its self-hosted runner's host-config snapshot): login, live runtime state and caches.
 */
const CLAUDE_RUNTIME_STATE_ENTRIES = [
  '.claude.json',
  '.claude.json.backup',
  '.credentials.json',
  '.session_ingress_token',
  'active-time.json',
  'antproto.json',
  'api-dumps',
  'backups',
  'bridge-spawn',
  'cache',
  'ccr',
  'ccr-home-seed.json',
  'chrome',
  'computer-use.lock',
  'daemon',
  'debug',
  'downloads',
  'dump-prompts',
  'feedback',
  'feedback-bundles',
  'file-history',
  'file-transfers',
  'gh-pr-status-cache.json',
  'hfi-auth.json',
  'history.jsonl',
  'ide',
  'image-cache',
  'jobs',
  'local',
  'local-settings',
  'logs',
  'loop.md',
  'mcp-discovery-cache',
  'mcp-needs-auth-cache.json',
  'mcp-skill-archives',
  'paste-cache',
  'plans',
  'policy-limits.json',
  'project-settings',
  'projects',
  'remote',
  'remote-control',
  'remote-settings.json',
  'scratch',
  'seed-admin',
  'server-sessions.json',
  'server.lock',
  'session-env',
  'sessions',
  'shares',
  'shell-snapshots',
  'startup-perf',
  'state',
  'stats-cache.json',
  'statsig',
  'storage-v2',
  'systemd',
  'tasks',
  'teams',
  'telemetry',
  'todos',
  'traces',
  'uploads',
  'usage-data'
] as const

/** Never linked or copied: runtime state, settings.json (copied whole) and history (linked the other way). */
const UNSHARED_ENTRIES: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_RUNTIME_STATE_ENTRIES,
  'settings.json',
  ...CLAUDE_PROFILE_HISTORY_DIRS
])

function isSharedEntry(name: string): boolean {
  // Why the prefixes: Claude's own seeding skips every hidden entry (state files, tokens, locks),
  // daemon files and per-folder agent memory too.
  return (
    !UNSHARED_ENTRIES.has(name) &&
    !name.startsWith('.') &&
    !name.startsWith('daemon') &&
    !name.startsWith('agent-memory')
  )
}

/**
 * Mirrors what Claude itself resets in .claude.json when it signs out (its logout, 2.1.295), plus
 * the subscription notices it resets with them. Onboarding, which logout also resets, is copied.
 */
const CLAUDE_LOGOUT_STATE_KEYS = [
  'oauthAccount',
  'additionalModelOptionsCache',
  'additionalModelOptionsAnsweredAt',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'cachedArtifactRoster',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'metricsStatusCache',
  'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache',
  'startupPrefetchedAt',
  'subscriptionNoticeCount',
  'hasAvailableSubscription'
] as const

/** Never copied: logout's keys, the install ids Claude writes before any sign-in, and logins. */
const ACCOUNT_BOUND_STATE_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_LOGOUT_STATE_KEYS,
  'userID',
  'machineID',
  'firstStartTime',
  'firstStartVersion',
  // Why: a Console API key login; copied, it would outrank the account's own login.
  'primaryApiKey',
  // Why: Claude never refetches it.
  'claudeCodeFirstTokenDate'
])

function isAccountBoundState(key: string): boolean {
  // Why the patterns too: account caches logout leaves behind (groveConfigCache, passes*).
  return (
    ACCOUNT_BOUND_STATE_KEYS.has(key) ||
    key.includes('Cache') ||
    key.startsWith('cached') ||
    key.startsWith('passes')
  )
}

// Why without Orca's hooks: the profile's own hook install owns those, so differing there alone
// would recopy, and the install rewrite, the file on every launch.
function settingsWithoutOrcaHooks(value: Record<string, unknown>): string {
  return JSON.stringify(removeManagedHooks(value, getManagedScriptFileName()).config)
}

/** The whole file: the default home is the master copy, proxy address and key included. */
function copySettings(source: string, target: string): ClaudeProfileSurfaceOutcome {
  const input = readClaudeProfileObject(source)
  const current = readClaudeProfileObject(target)
  // Why by value: the hook installer rewrites the copy in its own layout after every refresh.
  if (
    input.kind === 'present' &&
    current.kind === 'present' &&
    !lstatIfPresent(target)?.isSymbolicLink() &&
    settingsWithoutOrcaHooks(input.value) === settingsWithoutOrcaHooks(current.value)
  ) {
    return 'unchanged'
  }
  const outcome = copyClaudeProfileFile(source, target)
  if (outcome === 'absent' && lstatIfPresent(target)?.isFile()) {
    rmSync(target, { force: true })
    return 'synced'
  }
  return outcome
}

/** Keyed by folder path or server name: entries the account recorded on its own are kept. */
const MERGED_BY_ENTRY: ReadonlySet<string> = new Set(['projects', 'mcpServers'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeEntries(key: string, current: unknown, source: unknown): unknown {
  if (!isPlainRecord(current) || !isPlainRecord(source)) {
    return source
  }
  const merged: Record<string, unknown> = { ...current, ...source }
  if (key === 'projects') {
    for (const [path, entry] of Object.entries(source)) {
      const own = current[path]
      // Why: a folder trusted in the account, often by Orca just before launch, stays trusted.
      if (isPlainRecord(own) && own.hasTrustDialogAccepted === true && isPlainRecord(entry)) {
        merged[path] = { ...entry, hasTrustDialogAccepted: true }
      }
    }
  }
  return merged
}

async function copyState(source: string, target: string): Promise<ClaudeProfileSurfaceOutcome> {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(source)
  if (input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Personal Claude state is unreadable')
  }
  if (input.kind === 'absent') {
    return 'absent'
  }
  const shared = Object.entries(input.value).filter(([key]) => !isAccountBoundState(key))
  if (!lstatIfPresent(target)) {
    const staged = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(staged, `${JSON.stringify(Object.fromEntries(shared), null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600
      })
      // Why a link, not a rename: whole or absent, and Claude's own file, created meanwhile, wins.
      if (publishFileWithoutOverwrite(staged, target)) {
        return 'synced'
      }
    } finally {
      rmSync(staged, { force: true })
    }
  }
  // Why no deletions: a key the default home lacks may be one Claude added only in this folder.
  const outcome = await updateClaudeGlobalConfig(target, (current) => {
    const config = { ...current }
    for (const [key, value] of shared) {
      config[key] = MERGED_BY_ENTRY.has(key) ? mergeEntries(key, current[key], value) : value
    }
    return JSON.stringify(config) === JSON.stringify(current)
      ? { kind: 'unchanged' }
      : { kind: 'changed', config }
  })
  if (outcome === 'locked' || outcome === 'unreadable' || outcome === 'missing-config') {
    throw new ClaudeProfileSurfaceError(
      outcome === 'locked' ? 'locked' : 'unreadable',
      `Profile Claude state is ${outcome}`
    )
  }
  return outcome === 'updated' ? 'merged' : 'unchanged'
}

/**
 * Refreshes a profile from the default home, the master copy: everything but the login and
 * account-bound items. Execution-host paths; never writes the default home or credentials.
 * Callers go through provisionClaudeAccountProfile, which gates and creates the profile.
 */
export async function provisionClaudeProfile(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileReport> {
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  const report = createClaudeProfileReport()
  // Why only for ~/.claude: Claude also loads it as a parent folder's memory for projects under
  // home, so a copy would load twice; a custom CLAUDE_CONFIG_DIR is copied, as superset does.
  const imported = resolve(defaultHome) === resolve(args.userHome, '.claude')
  let names: string[] = []
  try {
    names = readdirSync(defaultHome).filter(isSharedEntry)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      warnClaudeProfile(report, 'profile', error)
    }
  }
  for (const name of names) {
    const source = join(defaultHome, name)
    const target = join(args.profileHome, name)
    await runClaudeProfileSurface(report, name, () => {
      // Why stat, not lstat: a linked entry is shared as what it points at.
      const entry = statSync(source, { throwIfNoEntry: false })
      if (entry?.isDirectory()) {
        return linkClaudeProfileDirectory(source, target, platform)
      }
      if (!entry?.isFile()) {
        return 'absent'
      }
      return name === 'CLAUDE.md' && imported
        ? copyClaudeProfileFile(source, target, () => Buffer.from(CLAUDE_PROFILE_MEMORY_IMPORT))
        : copyClaudeProfileFile(source, target)
    })
  }
  await runClaudeProfileSurface(report, 'settings.json', () =>
    copySettings(join(defaultHome, 'settings.json'), join(args.profileHome, 'settings.json'))
  )
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  await runClaudeProfileSurface(report, '.claude.json', () =>
    copyState(statePath(args.userConfigDir), statePath(args.profileHome))
  )
  return report
}
