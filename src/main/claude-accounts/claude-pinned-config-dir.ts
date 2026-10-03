import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  type Stats
} from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/**
 * Makes a managed account's auth dir usable as a pinned launch's CLAUDE_CONFIG_DIR.
 *
 * A bare managed dir holds only credentials, so Claude would start without Orca's hooks (the
 * worker never reports a turn), replay onboarding and trust prompts, and write transcripts no
 * Orca scanner looks at. Each launch mirrors just enough of the host config dir to avoid that;
 * everything else (CLAUDE.md, agents, plugins, MCP servers) is deliberately not inherited.
 */

// Keys Claude reads to decide whether to replay first-run screens; copied only when absent.
const FIRST_RUN_CONFIG_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'theme',
  'bypassPermissionsModeAccepted'
] as const

export type ClaudePinnedConfigDirSource = {
  /** The host config dir a normal launch uses. */
  hostConfigDir: string
  /** The host `.claude.json` a normal launch uses (colocated or `~/.claude.json`). */
  hostConfigPath: string
}

export function prepareClaudePinnedConfigDir(args: {
  configDir: string
  source: ClaudePinnedConfigDirSource
  oauthAccount: unknown
  platform?: NodeJS.Platform
}): void {
  const platform = args.platform ?? process.platform
  linkSharedProjectsDir(args.configDir, args.source.hostConfigDir, platform)
  mirrorHostSettings(args.configDir, args.source.hostConfigDir)
  mergeFirstRunConfig(args.configDir, args.source.hostConfigPath, args.oauthAccount)
}

/** Shares transcripts so resume and every session scanner find pinned sessions too. */
function linkSharedProjectsDir(
  configDir: string,
  hostConfigDir: string,
  platform: NodeJS.Platform
): void {
  const target = resolve(hostConfigDir, 'projects')
  const linkPath = join(configDir, 'projects')
  mkdirSync(target, { recursive: true })
  const existing = lstatOrNull(linkPath)
  if (existing?.isSymbolicLink()) {
    if (resolve(configDir, readlinkSync(linkPath)) === target) {
      return
    }
    rmSync(linkPath, { force: true })
  } else if (existing?.isDirectory()) {
    // Why: a non-empty real dir holds sessions written before linking existed; never delete them.
    if (readdirSync(linkPath).length > 0) {
      return
    }
    rmdirSync(linkPath)
  } else if (existing) {
    return
  }
  // Why: a junction needs no Developer Mode or admin rights on Windows, unlike a dir symlink.
  symlinkSync(target, linkPath, platform === 'win32' ? 'junction' : 'dir')
}

/** Hooks and the statusline live in settings.json; mirror it so the pinned Claude reports status. */
function mirrorHostSettings(configDir: string, hostConfigDir: string): void {
  const hostSettingsPath = join(hostConfigDir, 'settings.json')
  let contents: string
  try {
    if (!existsSync(hostSettingsPath)) {
      return
    }
    contents = readFileSync(hostSettingsPath, 'utf-8')
  } catch {
    return
  }
  const pinnedSettingsPath = join(configDir, 'settings.json')
  if (readFileOrNull(pinnedSettingsPath) === contents) {
    return
  }
  writeFileAtomically(pinnedSettingsPath, contents, { mode: 0o600 })
}

/** Add-only, so anything the pinned Claude wrote for itself is never overwritten. */
function mergeFirstRunConfig(
  configDir: string,
  hostConfigPath: string,
  oauthAccount: unknown
): void {
  const pinnedConfigPath = join(configDir, '.claude.json')
  const pinnedExists = existsSync(pinnedConfigPath)
  const pinnedRaw = pinnedExists ? readFileOrNull(pinnedConfigPath) : null
  const pinned = pinnedExists ? (pinnedRaw === null ? null : parseJsonObject(pinnedRaw)) : {}
  if (!pinned) {
    // Why: an unparseable file is Claude's own state; rewriting it could erase its history.
    return
  }
  const hostRaw = readFileOrNull(hostConfigPath)
  const host = (hostRaw === null ? null : parseJsonObject(hostRaw)) ?? {}
  let changed = false
  for (const key of FIRST_RUN_CONFIG_KEYS) {
    if (!(key in pinned) && key in host) {
      pinned[key] = host[key]
      changed = true
    }
  }
  const hostProjects = asRecord(host.projects)
  if (hostProjects) {
    const pinnedProjects = asRecord(pinned.projects) ?? {}
    let projectsChanged = false
    for (const [projectPath, entry] of Object.entries(hostProjects)) {
      if (asRecord(entry)?.hasTrustDialogAccepted !== true) {
        continue
      }
      const pinnedEntry = asRecord(pinnedProjects[projectPath])
      if (pinnedEntry?.hasTrustDialogAccepted === true) {
        continue
      }
      pinnedProjects[projectPath] = { ...pinnedEntry, hasTrustDialogAccepted: true }
      projectsChanged = true
    }
    if (projectsChanged) {
      pinned.projects = pinnedProjects
      changed = true
    }
  }
  if (!('oauthAccount' in pinned) && oauthAccount !== null && oauthAccount !== undefined) {
    pinned.oauthAccount = oauthAccount
    changed = true
  }
  if (changed) {
    writeFileAtomically(pinnedConfigPath, `${JSON.stringify(pinned, null, 2)}\n`, {
      mode: 0o600
    })
  }
}

function lstatOrNull(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath)
  } catch {
    return null
  }
}

function readFileOrNull(targetPath: string): string | null {
  try {
    return readFileSync(targetPath, 'utf-8')
  } catch {
    return null
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed to a non-null, non-array object above.
  return value as Record<string, unknown>
}
