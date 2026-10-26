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
import { CLAUDE_PROFILE_HISTORY_DIRS, mergeClaudeProfileDirectory } from './claude-profile-history'
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

// Match runtime exclusions in Claude's self-hosted host-config snapshot.
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

// Settings and history have dedicated sharing paths; runtime state stays private.
const UNSHARED_ENTRIES: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_RUNTIME_STATE_ENTRIES,
  'settings.json',
  ...CLAUDE_PROFILE_HISTORY_DIRS
])

function isSharedEntry(name: string): boolean {
  // Match Claude seeding exclusions for hidden state, daemon files, and per-folder memory.
  return (
    !UNSHARED_ENTRIES.has(name) &&
    !name.startsWith('.') &&
    !name.startsWith('daemon') &&
    !name.startsWith('agent-memory')
  )
}

// Claude 2.1.295 logout keys and subscription notices; onboarding remains shareable.
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

const ACCOUNT_BOUND_STATE_KEYS: ReadonlySet<string> = new Set<string>([
  ...CLAUDE_LOGOUT_STATE_KEYS,
  'userID',
  'machineID',
  'firstStartTime',
  'firstStartVersion',
  // A copied Console key would override the account's own login.
  'primaryApiKey',
  // Claude never refetches this account-specific date.
  'claudeCodeFirstTokenDate'
])

function isAccountBoundState(key: string): boolean {
  // Logout leaves additional account caches such as groveConfigCache and passes*.
  return (
    ACCOUNT_BOUND_STATE_KEYS.has(key) ||
    key.includes('Cache') ||
    key.startsWith('cached') ||
    key.startsWith('passes')
  )
}

// Ignore managed hooks to avoid copy/install churn on every launch.
function settingsWithoutOrcaHooks(value: Record<string, unknown>): string {
  return JSON.stringify(removeManagedHooks(value, getManagedScriptFileName()).config)
}

// Keep proxy addresses and credentials together in the settings copy.
function copySettings(source: string, target: string): ClaudeProfileSurfaceOutcome {
  const input = readClaudeProfileObject(source)
  const current = readClaudeProfileObject(target)
  // Compare values because hook installation changes serialization.
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

// Preserve account-only project and server entries during merging.
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
      // Preserve trust granted in this account, including just before launch.
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
      // Publish atomically without replacing a file Claude created concurrently.
      if (publishFileWithoutOverwrite(staged, target)) {
        return 'synced'
      }
    } finally {
      rmSync(staged, { force: true })
    }
  }
  // Preserve keys Claude added only in this account folder.
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

/** Call after ownership checks on the execution host; preserve account-bound state and credentials. */
export async function provisionClaudeProfile(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
  platform?: NodeJS.Platform
  /** Before the setup marker, a folder in the profile is one Claude made, not one the user owns. */
  firstSetup?: boolean
}): Promise<ClaudeProfileReport> {
  const platform = args.platform ?? process.platform
  const defaultHome = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  const report = createClaudeProfileReport()
  // Import ~/.claude memory to avoid duplicate parent-memory loading; copy custom homes.
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
      // Share linked entries according to their target type.
      const entry = statSync(source, { throwIfNoEntry: false })
      if (entry?.isDirectory()) {
        const outcome = linkClaudeProfileDirectory(source, target, platform)
        // Why: a pane's `claude` can run before setup and create e.g. plugins/installed_plugins.json.
        return outcome === 'user-owned' && args.firstSetup && lstatIfPresent(target)?.isDirectory()
          ? mergeClaudeProfileDirectory(args.profileHome, defaultHome, name, platform, report)
          : outcome
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
