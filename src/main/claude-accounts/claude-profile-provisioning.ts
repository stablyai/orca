import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { resolveClaudeGlobalConfigFile } from '../claude/claude-folder-trust-file'
import { CLAUDE_PROFILE_HISTORY_DIRS, mergeClaudeProfileDirectory } from './claude-profile-history'
import { resolveClaudeDefaultHome } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport
} from './claude-profile-report'
import { refreshClaudeProfileSharedConfig } from './claude-profile-shared-refresh'
import { isPlainRecord } from './claude-profile-shared-units'
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

// Folders of the user's own Claude content; an unknown folder may be runtime state of a newer Claude.
const CLAUDE_USER_CONTENT_DIRS = [
  'agents',
  'commands',
  'output-styles',
  'plugins',
  'rules',
  'skills',
  'themes',
  'workflows'
] as const

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

// Trust granted in this account stays when the user's entry for that folder is copied in.
function mergeProjects(current: unknown, source: unknown): unknown {
  if (!isPlainRecord(current) || !isPlainRecord(source)) {
    return source
  }
  const merged: Record<string, unknown> = { ...current, ...source }
  for (const [path, entry] of Object.entries(source)) {
    const own = current[path]
    if (isPlainRecord(own) && own.hasTrustDialogAccepted === true && isPlainRecord(entry)) {
      merged[path] = { ...entry, hasTrustDialogAccepted: true }
    }
  }
  return merged
}

// Keys other than the reconciled values copy one way from the user, as before.
function copyStateRest(
  user: Record<string, unknown>,
  account: Record<string, unknown>
): Record<string, unknown> {
  const config = { ...account }
  for (const [key, value] of Object.entries(user)) {
    if (!isAccountBoundState(key) && key !== 'mcpServers') {
      config[key] = key === 'projects' ? mergeProjects(account.projects, value) : value
    }
  }
  return config
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
  /** Orca's data folder; its other prepared accounts are reconciled first, under one host lock. */
  dataRoot?: string
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
  // Why: a shared folder Claude made here while the user's folder had none would stay private.
  for (const name of CLAUDE_USER_CONTENT_DIRS) {
    if (!names.includes(name) && lstatIfPresent(join(args.profileHome, name))?.isDirectory()) {
      await runClaudeProfileSurface(report, name, () =>
        mergeClaudeProfileDirectory(args.profileHome, defaultHome, name, platform, report)
      )
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
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  await refreshClaudeProfileSharedConfig({
    profileHome: args.profileHome,
    defaultHome,
    userState: statePath(args.userConfigDir),
    statePath,
    dataRoot: args.dataRoot,
    firstSetup: args.firstSetup,
    report,
    copyRest: copyStateRest
  })
  return report
}
