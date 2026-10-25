import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
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
