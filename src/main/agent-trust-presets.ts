import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { upsertOrcaCreatedProjectTrustLevel } from './codex/config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'
import type { TuiAgentConfig } from '../shared/tui-agent-config'

export type AgentTrustPreset = NonNullable<TuiAgentConfig['preflightTrust']>

/**
 * Pre-mark a workspace as trusted for cursor-agent, GitHub Copilot CLI, or
 * Codex so the agent's "Do you trust this folder?" menu does not fire on
 * first launch.
 *
 * Why: Orca's "drop URL into agent input as a draft" flow injects the URL
 * via bracketed-paste once the TUI is up. If the trust menu intercepts the
 * keystrokes (each menu reads a single character or numbered option), the
 * paste either selects an arbitrary option or quits the session. Pre-writing
 * the same trust artifacts that the agent writes after the user accepts is
 * the only documented bypass — both CLIs read these files at startup before
 * showing the menu.
 *
 * Side note: a `--trust`-style CLI flag exists in cursor-agent but only
 * applies in `--print/headless` mode (per its --help). Copilot has no
 * documented flag at all (verified against @github/copilot 1.0.32 bundle).
 * Codex's `--dangerously-bypass-approvals-and-sandbox` would also change
 * approval/sandbox policy, so it is not equivalent to "trust this project".
 */

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
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

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
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
    // Why: a corrupted config.json is the user's to fix — refuse to overwrite
    // it from this side-effect path. Copilot will rewrite the file itself
    // after the user accepts the trust prompt manually.
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
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * The Antigravity CLI (agy) keeps its trusted workspaces in
 * ~/.gemini/antigravity-cli/settings.json under `trustedWorkspaces`, a flat
 * array of absolute paths in native OS form.
 *
 * Verified empirically against agy 1.2.7 on Windows: accepting the CLI's
 * "Do you trust the contents of this project?" prompt for a freshly created
 * worktree appended exactly that worktree's path to this array. Note this is
 * NOT ~/.gemini/trustedFolders.json — that file belongs to the Gemini CLI and
 * agy does not consult it.
 *
 * Trust is exact-path and NOT inherited by subdirectories: `C:\Users\<you>`
 * was already present in the array, yet launching agy in a descendant still
 * raised the prompt and appended the descendant separately. Every new child
 * worktree therefore needs its own entry, which is precisely what this
 * per-worktree preflight provides.
 *
 * We append in-place so the sibling keys in the same file (model, permissions,
 * toolPermission, agentMode, …) survive untouched.
 */
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
    // Why: a corrupted settings.json is the user's to fix — refuse to
    // overwrite it from this side-effect path. agy rewrites the file itself
    // once the user accepts the trust prompt manually.
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

/**
 * Codex stores project trust in ~/.codex/config.toml under:
 *   [projects."<realpath>"]
 *   trust_level = "trusted"
 *
 * Verified against codex-rs/tui/src/onboarding/trust_directory.rs and
 * codex-rs/core/src/config/config_tests.rs in the Codex CLI source.
 *
 * `configFiles` names every config.toml the launched Codex may read, in the
 * hook installer's lock order (an Orca-owned CODEX_HOME before the system one).
 */
export function markCodexProjectTrusted(
  workspacePath: string,
  configFiles: readonly string[]
): Promise<void> {
  // Why: Codex checks the cwd's own entry before the repo root, so no git-layout logic is needed.
  const absPath = canonicalize(workspacePath)
  // Why (#16441): hook installs read and rewrite these files across awaits, so
  // an unqueued write here could land between their read and their write and be
  // lost. Same runtime-before-system lock order the installer takes.
  const write = configFiles.reduceRight<() => Promise<void>>(
    (inner, configFile) => () => runExclusivelyForCodexTrustConfig(configFile, inner),
    async () => {
      for (const configFile of configFiles) {
        upsertOrcaCreatedProjectTrustLevel(configFile, absPath, 'trusted')
      }
    }
  )
  return write()
}

function canonicalize(p: string): string {
  // Why: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, but
  // both Cursor and Copilot's trust comparators run realpath() before the
  // string compare. Mirror that so a worktree under a symlinked parent
  // (orca caches realpath()'d worktree paths) matches the agent's lookup.
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {
    // Fall through to the raw input.
  }
  return p
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Why: Windows absolute paths include characters such as ":" that cannot
  // be used in the ~/.cursor/projects/<slug> directory name.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
