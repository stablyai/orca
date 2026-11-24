import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { grantCodexProjectTrustOffMain } from '../../codex/trust/project-trust/codex-project-trust-worker-client'
import { runExclusivelyForCodexTrustConfig } from '../../codex/trust/toml/codex-trust-config-mutation-queue'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { isPlainObject } from '../../agent-hooks/installation/configuration/hooks-json-read'
import { canonicalizeAgentTrustPath as canonicalize } from './agent-trust-path-canonicalization'
import { recordOrcaCreatedAntigravityTrust } from './antigravity-workspace-trust-ownership'
import type { TuiAgentConfig } from '../../../shared/agent-launch/catalog/tui-agent-config-types'

export type AgentTrustPreset = NonNullable<TuiAgentConfig['preflightTrust']>

// Prewrite workspace trust so first-launch menus cannot consume a drafted URL as input.
// Trust artifacts preserve the agent’s approval and sandbox policy.

export function markCursorWorkspaceTrusted(workspacePath: string, home: string): void {
  const absPath = canonicalize(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return
  }
  const trustDir = join(home, '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
}

export function markCopilotFolderTrusted(workspacePath: string, home: string): void {
  const absPath = canonicalize(workspacePath)
  const configDir = join(home, '.copilot')
  const configPath = join(configDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = Object.fromEntries(Object.entries(parsed))
      }
    }
  } catch {
    // Preserve corrupt user config; the agent can repair it after manual trust approval.
    return
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalize(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  const next = [...existing.filter((e) => typeof e === 'string'), absPath]
  config.trustedFolders = next
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  // Copilot tokens require owner-only permissions, including on shared SSH hosts.
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Antigravity trust is exact-path; parent entries do not cover new child workspaces.
 * `guestPath` is the path a WSL agent sees, which this host cannot canonicalize.
 */
export function markAntigravityWorkspaceTrusted(
  workspacePath: string,
  home: string,
  guestPath?: string
): void {
  const absPath = guestPath ?? canonicalize(workspacePath)
  const configDir = join(home, '.gemini', 'antigravity-cli')
  const configPath = join(configDir, 'settings.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Preserve corrupt user settings; the agent can repair them after manual trust approval.
    return
  }
  const existing = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalize(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  config.trustedWorkspaces = [...existing.filter((e) => typeof e === 'string'), absPath]
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
  recordOrcaCreatedAntigravityTrust(configPath, workspacePath, absPath)
}

/** Kimi Code 2.3.1 keeps one exact-folder record per cwd (workspaceTrust/trustRecord.ts). */
export function markKimiWorkspaceTrusted(workspacePath: string, kimiHome: string): void {
  // Kimi keys on process.cwd(): physical on POSIX, the spawn path as given on Windows.
  const root = process.platform === 'win32' ? resolve(workspacePath) : canonicalize(workspacePath)
  const trustFile = join(kimiHome, 'workspace-trust', kimiWorkspaceTrustKey(root))
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 })
  writeFileAtomically(trustFile, JSON.stringify({ root, trustedAt: Date.now() }), { mode: 0o600 })
}

/** Mirrors Kimi's trustKey: canonicalWorkspaceRoot then encodeWorkDirKey (workdir-slug.ts). */
function kimiWorkspaceTrustKey(root: string): string {
  const slashed = root.replaceAll('\\', '/')
  const trimmed = slashed.replace(/\/+$/, '')
  const normalized = /^(?:[A-Za-z]:\/|\/\/)/.test(slashed) ? trimmed.toLowerCase() : trimmed
  const slug = (normalized.split('/').pop() ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, '')
  const name = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `wd_${name}_${hash}`
}

/**
 * Mistral Vibe stores trust as two path lists in `$VIBE_HOME/trusted_folders.toml`
 * (core/trusted_folders.py); a path in `untrusted` is refused even after a later trust write, so the
 * entry has to be moved between the lists the way Vibe's own `trust()` does.
 */
export function markMistralVibeWorkspaceTrusted(
  workspacePath: string,
  env: Record<string, string | undefined>,
  home: string
): void {
  // Why: a relative VIBE_HOME is resolved from where Vibe starts, which is the workspace.
  const trustFile = join(vibeHome(env, home, workspacePath), 'trusted_folders.toml')
  if (vibeTrustStatus(trustFile, workspacePath) === 'trusted') {
    return
  }
  const lists = readVibeTrustLists(trustFile)
  if (!lists) {
    // Preserve a file Orca cannot parse; the agent can repair it after manual trust approval.
    return
  }
  const entry = vibeTrustKey(workspacePath)
  const trusted = lists.trusted.filter((path) => path !== entry)
  const untrusted = lists.untrusted.filter((path) => path !== entry)
  trusted.push(entry)
  mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 })
  writeFileAtomically(trustFile, stringifyToml({ trusted, untrusted }), { mode: 0o600 })
}

/**
 * `VIBE_HOME` moves the store; Vibe resolves it with `Path(...).expanduser().resolve()`, so a `~`
 * prefix means the agent's home and a relative path means the folder the agent was started in.
 */
function vibeHome(
  env: Record<string, string | undefined>,
  home: string,
  startFolder: string
): string {
  const raw = env.VIBE_HOME
  if (!raw) {
    return join(home, '.vibe')
  }
  const expanded =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(1)) : raw
  return resolve(startFolder, expanded)
}

/**
 * Vibe keys on `Path(workspace).expanduser().resolve()` (Python), which is the physical path, unlike
 * `fs.realpath` it does not fold Windows case. Reads both lists because a stale `untrusted` entry wins.
 */
function vibeTrustStatus(trustFile: string, workspacePath: string): 'trusted' | 'untrusted' | 'none' {
  const lists = readVibeTrustLists(trustFile)
  if (!lists) {
    return 'none'
  }
  const entry = vibeTrustKey(workspacePath)
  if (lists.untrusted.includes(entry)) {
    return 'untrusted'
  }
  return lists.trusted.includes(entry) ? 'trusted' : 'none'
}

function vibeTrustKey(workspacePath: string): string {
  try {
    return realpathSync.native(workspacePath)
  } catch {
    // Missing paths retain their supplied spelling, as Vibe's resolve() does.
    return resolve(workspacePath)
  }
}

/** Vibe also writes `untrusted`; a missing file holds neither list, and a broken one is left alone. */
function readVibeTrustLists(
  trustFile: string
): { trusted: string[]; untrusted: string[] } | null {
  let text: string
  try {
    text = readFileSync(trustFile, 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? { trusted: [], untrusted: [] } : null
  }
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch {
    return null
  }
  const lists: string[][] = []
  for (const name of ['trusted', 'untrusted']) {
    const value = isPlainObject(parsed) ? parsed[name] : undefined
    if (value === undefined) {
      lists.push([])
      continue
    }
    if (!Array.isArray(value) || !value.every((path) => typeof path === 'string')) {
      return null
    }
    lists.push(value)
  }
  return { trusted: lists[0], untrusted: lists[1] }
}

/** Lock configs in hook-installer order: managed runtime home before system home. */
export function markCodexProjectTrusted(
  workspacePath: string,
  configFiles: readonly string[]
): Promise<void> {
  // Serialize with hook installs so their capture/restore cannot overwrite the trust grant (#16441).
  const write = configFiles.reduceRight<() => Promise<void>>(
    (inner, configFile) => () => runExclusivelyForCodexTrustConfig(configFile, inner),
    () => grantCodexProjectTrustOffMain(configFiles, workspacePath)
  )
  return write()
}

function cursorWorkspaceSlug(absPath: string): string {
  // Mirrors cursor-agent's project-directory name; any mismatch leaves the trust menu up.
  return absPath
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}
