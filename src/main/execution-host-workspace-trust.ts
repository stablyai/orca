import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { markQoderWorkspaceTrusted } from './qoder/workspace-trust'
import {
  type AgentTrustPreset,
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted,
  resolveCodexProjectTrustRoot
} from './agent-trust-presets'
import { awaitAgentTrustWriteWithinDeadline } from './agent-trust-write-deadline'
import {
  type ClaudeTrustConfigTarget,
  grantClaudeWorkspaceTrust
} from './claude/claude-folder-trust-file'
import { isTooBroadToPreTrust } from '../shared/home-or-filesystem-root'

/**
 * What the host that runs the agent knows about where that agent reads trust. Relay-safe:
 * main describes this machine or a WSL guest, the SSH relay describes its own host.
 */
export type WorkspaceTrustHost = {
  /** Homes the agent may read trust under; with none known, an agent that inherits trust writes nothing. */
  homes: readonly (string | null | undefined)[]
  /** The config Claude reads on this host, or null when this host cannot tell. */
  claudeConfig: () => ClaudeTrustConfigTarget | null
  /** Every config.toml the launched Codex may read, in the hook installer's lock order. */
  codexConfigFiles: () => readonly string[]
  deadlineMs: number
}

/**
 * Whether trust on a home or a disk root would also trust the folders below it, per each agent's
 * own lookup; such trust is never pre-written. Claude walks up parent folders (to the repo root,
 * else the disk root); Copilot and Qoder accept any trusted ancestor. Codex matches its start
 * folder or that folder's repo root, Antigravity the exact folder, and Cursor never inherits from
 * a home, a folder above one or a shallow path.
 */
export const AGENT_TRUST_INHERITS_FROM_A_HOME: Record<AgentTrustPreset, boolean> = {
  claude: true,
  codex: false,
  cursor: false,
  copilot: true,
  qoder: true,
  antigravity: false
}

/**
 * Agents whose lookup keys on the folder they start in, so Orca trusts that folder, not the
 * workspace root, even outside any workspace. Codex checks its start folder, then that folder's
 * repo root; a non-git workspace root above the start folder is neither.
 */
export const AGENT_TRUST_KEYED_BY_START_FOLDER: Record<AgentTrustPreset, boolean> = {
  claude: false,
  codex: true,
  cursor: false,
  copilot: false,
  qoder: false,
  antigravity: false
}

// Why resolve() too: Claude stores it, and it collapses `..` even where realpath fails.
function withResolvedForm(path: string): string[] {
  try {
    return [path, resolve(path), realpathSync.native(path)]
  } catch {
    return [path, resolve(path)]
  }
}

/** The path the preset's writer stores: Codex trusts a linked worktree's main checkout. */
function storedTrustPath(preset: AgentTrustPreset, workspacePath: string): string {
  return preset === 'codex' ? resolveCodexProjectTrustRoot(workspacePath) : workspacePath
}

/**
 * Whether trust stored for `storedPath` would cover a home: it is a root, a home or a folder
 * above one. Both sides are compared given and resolved, since the writers store the realpath.
 */
function wouldTrustAHome(storedPath: string, homes: readonly string[]): boolean {
  const homeForms = homes.flatMap(withResolvedForm)
  return withResolvedForm(storedPath).some((form) => isTooBroadToPreTrust(form, homeForms))
}

async function writePreset(
  preset: AgentTrustPreset,
  storedPath: string,
  host: WorkspaceTrustHost
): Promise<void> {
  switch (preset) {
    case 'claude': {
      const target = host.claudeConfig()
      if (target) {
        await grantClaudeWorkspaceTrust(target, storedPath)
      }
      return
    }
    case 'codex':
      return markCodexProjectTrusted(storedPath, host.codexConfigFiles())
    case 'cursor':
      return markCursorWorkspaceTrusted(storedPath)
    case 'copilot':
      return markCopilotFolderTrusted(storedPath)
    case 'qoder':
      return markQoderWorkspaceTrusted(storedPath)
    case 'antigravity':
      return markAntigravityWorkspaceTrusted(storedPath)
  }
}

/**
 * The one place a preset's trust is written, on the host that runs the agent. For an agent that
 * inherits trust from a home, refuses when the path the writer would store covers a home. Never
 * throws or waits past the host's deadline: any failure or miss means the agent asks.
 */
export async function applyWorkspaceTrustOnThisHost(
  preset: AgentTrustPreset,
  workspacePath: string,
  describeHost: () => WorkspaceTrustHost
): Promise<void> {
  try {
    const host = describeHost()
    const storedPath = storedTrustPath(preset, workspacePath)
    if (AGENT_TRUST_INHERITS_FROM_A_HOME[preset]) {
      const homes = host.homes.filter((home): home is string => Boolean(home))
      if (homes.length === 0 || wouldTrustAHome(storedPath, homes)) {
        return
      }
    }
    await awaitAgentTrustWriteWithinDeadline(writePreset(preset, storedPath, host), {
      preset,
      workspacePath,
      deadlineMs: host.deadlineMs
    })
  } catch (error) {
    console.warn(
      `[agent-trust] ${preset} trust for ${workspacePath} failed; the agent will ask`,
      error
    )
  }
}
