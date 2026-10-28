import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'
import type { TuiAgentConfig } from '../shared/tui-agent-config'

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

/** Antigravity trust is exact-path; parent entries do not cover new child workspaces. */
export function markAntigravityWorkspaceTrusted(workspacePath: string, home: string): void {
  const absPath = canonicalize(workspacePath)
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

/** Lock configs in hook-installer order: managed runtime home before system home. */
export function markCodexProjectTrusted(
  workspacePath: string,
  configFiles: readonly string[]
): Promise<void> {
  // Codex checks the starting folder before its repository root; no Git-layout lookup is needed.
  const absPath = canonicalize(workspacePath)
  // Serialize with hook installs so their capture/restore cannot overwrite the trust grant (#16441).
  const write = configFiles.reduceRight<() => Promise<void>>(
    (inner, configFile) => () => runExclusivelyForCodexTrustConfig(configFile, inner),
    async () => {
      for (const configFile of configFiles) {
        upsertProjectTrustLevel(configFile, absPath, 'trusted')
      }
    }
  )
  return write()
}

function canonicalize(p: string): string {
  // Match agent trust lookups that compare realpaths, including macOS /tmp symlinks.
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {}
  return p
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Windows paths contain characters forbidden in Cursor’s project-directory names.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
