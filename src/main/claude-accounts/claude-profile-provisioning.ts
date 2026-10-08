import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  resolveClaudeGlobalConfigFile,
  updateClaudeGlobalConfig
} from '../claude/claude-folder-trust-file'
import { claudeStateLogin } from './claude-account-folder'
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
import {
  claudeProfileLedgerPath,
  dropClaudeProfileKeys,
  linkClaudeProfileDirectory,
  mergeClaudeProfileKeys,
  readClaudeProfileLedger,
  syncClaudeProfileFile,
  writeClaudeProfileLedger,
  type ClaudeProfileLedger
} from './claude-profile-sharing'

export const CLAUDE_PROFILE_RESOURCE_DIRS = [
  'skills',
  'plugins',
  'agents',
  'commands',
  'output-styles',
  'rules',
  'themes',
  'workflows'
] as const
// Copied, not linked: a rename-replace save (Claude's own, or an editor's) would cut a link.
export const CLAUDE_PROFILE_RESOURCE_FILES = ['CLAUDE.md', 'keybindings.json'] as const
const CLAUDE_PROFILE_MEMORY_IMPORT = '@~/.claude/CLAUDE.md\n'
const PRIVATE_KEYS = new Set([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'forceLoginMethod',
  'forceLoginOrgUUID'
])
const PRIVATE_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
])
const SHARED_STATE_KEYS = ['mcpServers', 'theme']

// Why `hooks` is shared: Orca writes identical entries into every folder, so the installer that
// runs after the merge finds them present and the user's own hooks keep running in every account.
function pickSettings(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
      .map(([key, value]) => {
        if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
          return [
            key,
            Object.fromEntries(Object.entries(value).filter(([name]) => !PRIVATE_ENV.has(name)))
          ]
        }
        return [key, value]
      })
  )
}

function mergeSettings(
  source: string,
  target: string,
  ledger: ClaudeProfileLedger
): ClaudeProfileSurfaceOutcome {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const existing = readClaudeProfileObject(target)
  const input = readClaudeProfileObject(source)
  if (existing.kind === 'unavailable' || input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Claude settings.json is unreadable')
  }
  const config: Record<string, unknown> = existing.kind === 'present' ? { ...existing.value } : {}
  const desired = pickSettings(input.kind === 'present' ? input.value : {})
  const written = { ...ledger.keys['settings.json'] }
  const changed =
    mergeClaudeProfileKeys(config, desired, written).length +
    dropClaudeProfileKeys(config, desired, written).length
  if (changed > 0) {
    writeFileAtomically(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  }
  // Committed only after the write, so a failed write never marks an unwritten value as shared.
  ledger.keys['settings.json'] = written
  return changed > 0 ? 'merged' : existing.kind === 'absent' ? 'absent' : 'unchanged'
}

async function mergeState(args: {
  source: string
  target: string
  ledger: ClaudeProfileLedger
  report: ClaudeProfileReport
}): Promise<ClaudeProfileSurfaceOutcome> {
  if (lstatIfPresent(args.target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(args.source)
  if (input.kind === 'unavailable') {
    // Why: onboarding doesn't depend on the personal state; only its shared keys wait.
    const error = new ClaudeProfileSurfaceError('unreadable', 'Personal Claude state is unreadable')
    warnClaudeProfile(args.report, '.claude.json', error)
  }
  const source = input.kind === 'present' ? input.value : {}
  const desired = Object.fromEntries(
    SHARED_STATE_KEYS.filter((key) => key in source).map((key) => [key, source[key]])
  )
  let written: Record<string, string> = {}
  let signedOut = false
  const outcome = await updateClaudeGlobalConfig(args.target, (current) => {
    // Why oauthAccount: Claude writes it only on a finished sign-in, while it writes this file
    // earlier in onboarding (theme pick). It's read under Claude's own lock, on every platform;
    // credentials sit in the Keychain on macOS. A flag set before then skips Claude's sign-in.
    signedOut = !claudeStateLogin(current)
    if (signedOut) {
      return { kind: 'unchanged' }
    }
    const config = { ...current }
    written = { ...args.ledger.keys['.claude.json'] }
    let changed = mergeClaudeProfileKeys(config, desired, written).length > 0
    if (
      input.kind !== 'unavailable' &&
      dropClaudeProfileKeys(config, desired, written).length > 0
    ) {
      changed = true
    }
    // Why: otherwise first launch opens the onboarding wizard, where a stray Enter starts a login that rebinds the profile.
    if (config.hasCompletedOnboarding !== true) {
      config.hasCompletedOnboarding = true
      changed = true
    }
    return changed ? { kind: 'changed', config } : { kind: 'unchanged' }
  })
  if (outcome === 'missing-config' || (outcome === 'unchanged' && signedOut)) {
    // Why: no completed login yet; writing would fabricate an account or skip Claude's sign-in.
    return 'absent'
  }
  if (outcome === 'locked' || outcome === 'unreadable') {
    throw new ClaudeProfileSurfaceError(outcome, `Profile Claude state is ${outcome}`)
  }
  args.ledger.keys['.claude.json'] = written
  return outcome === 'updated' ? 'merged' : 'unchanged'
}

/**
 * Shares the default home's config into a profile. Execution-host paths; never touches credentials.
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
  const ledgerPath = claudeProfileLedgerPath(args.profileHome)
  const ledger = readClaudeProfileLedger(ledgerPath)
  const recorded = JSON.stringify(ledger)
  for (const name of CLAUDE_PROFILE_RESOURCE_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      linkClaudeProfileDirectory(join(defaultHome, name), join(args.profileHome, name), platform)
    )
  }
  // Why only for ~/.claude: Claude also loads it as a parent folder's memory for projects under
  // home, so a copy would load twice; a custom CLAUDE_CONFIG_DIR is copied, as superset does.
  const imported = resolve(defaultHome) === resolve(args.userHome, '.claude')
  const memory = imported ? () => CLAUDE_PROFILE_MEMORY_IMPORT : undefined
  for (const name of CLAUDE_PROFILE_RESOURCE_FILES) {
    await runClaudeProfileSurface(report, name, () =>
      syncClaudeProfileFile(
        join(defaultHome, name),
        join(args.profileHome, name),
        name,
        ledger,
        name === 'CLAUDE.md' ? memory : undefined
      )
    )
  }
  await runClaudeProfileSurface(report, 'settings.json', () =>
    mergeSettings(
      join(defaultHome, 'settings.json'),
      join(args.profileHome, 'settings.json'),
      ledger
    )
  )
  const statePath = (configDir: string | undefined): string =>
    resolveClaudeGlobalConfigFile({
      env: { CLAUDE_CONFIG_DIR: configDir },
      homeDir: args.userHome,
      style: platform === 'win32' ? 'win32' : 'posix',
      exists: existsSync
    })
  await runClaudeProfileSurface(report, '.claude.json', () =>
    mergeState({
      source: statePath(args.userConfigDir),
      target: statePath(args.profileHome),
      ledger,
      report
    })
  )
  await runClaudeProfileSurface(report, 'ledger', () => {
    if (JSON.stringify(ledger) === recorded) {
      return 'unchanged'
    }
    writeClaudeProfileLedger(ledgerPath, ledger)
    return 'synced'
  })
  return report
}
