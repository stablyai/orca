import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'

// Why: these mirror the path constants in ai-vault/session-scanner.ts. Reads
// run in the main process against the runtime's own home directory; over SSH
// the remote main resolves its local home, so we never hardcode an absolute
// user path — homedir()/CODEX_HOME resolution stays runtime-relative and is
// computed per call (not at module load) so it tracks the live home.
function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

// Why: Orca launches Codex with ORCA_CODEX_HOME pointing at its own managed
// runtime home, so Orca-started Codex rollout files land under
// `<managed home>/sessions`, NOT `~/.codex/sessions`. Search the managed home
// first (that's where this main process's Codex sessions actually live), then
// fall back to CODEX_HOME/~/.codex so a non-Orca Codex transcript still resolves.
// Duplicates are filtered so a managed-home symlink to ~/.codex isn't scanned twice.
function codexSessionsDirs(): string[] {
  const candidates = [
    join(getOrcaManagedCodexHomePath(), 'sessions'),
    join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions')
  ]
  return candidates.filter((dir, index) => candidates.indexOf(dir) === index)
}

export type ResolveSessionFileOptions = {
  /** Override the Claude projects root (used by tests / isolated scans). */
  claudeProjectsDir?: string
  /** Override the Codex sessions roots, searched in order (tests / isolated
   *  scans). Defaults to the orca-managed home then CODEX_HOME/~/.codex. */
  codexSessionsDirs?: string[]
  /** Authoritative transcript path reported by the agent hook
   *  (`providerSession.transcriptPath`). When set and the file exists, it is used
   *  directly — recent Claude Code names the transcript with a UUID that differs
   *  from the hook session_id, so the id-based glob below would miss it. */
  transcriptPath?: string
}

/**
 * Resolve the on-disk JSONL transcript path for a given agent + session id.
 *
 * Prefers the hook-reported `transcriptPath` when it exists on disk (authoritative).
 * Otherwise: Claude nests transcripts by project slug
 * (`~/.claude/projects/<slug>/<id>.jsonl`), so we glob the projects subdirs for
 * `<id>.jsonl`. Codex stores rollout files under date-nested dirs whose file name
 * embeds the session id, so we match by the session id appearing in the file name.
 * Returns null when no matching transcript exists.
 */
export async function resolveSessionFilePath(
  agent: AgentType,
  sessionId: string,
  options: ResolveSessionFileOptions = {}
): Promise<string | null> {
  // Why: the hook's transcript_path is the exact file the agent is writing, so it
  // beats reconstructing a path from the session id. Guard with existsSync so a
  // stale/remote path falls through to the id-based search rather than returning
  // a non-existent file.
  const hookPath = options.transcriptPath?.trim()
  if (hookPath && extname(hookPath) === '.jsonl' && existsSync(hookPath)) {
    return hookPath
  }

  const trimmedId = sessionId.trim()
  if (!trimmedId) {
    return null
  }

  if (agent === 'claude') {
    return resolveClaudeSessionFile(trimmedId, options.claudeProjectsDir ?? claudeProjectsDir())
  }
  if (agent === 'codex') {
    return resolveCodexSessionFile(trimmedId, options.codexSessionsDirs ?? codexSessionsDirs())
  }
  return null
}

async function resolveClaudeSessionFile(
  sessionId: string,
  projectsDir: string
): Promise<string | null> {
  const targetName = `${sessionId}.jsonl`
  const files = await walkSessionFiles(projectsDir, 'claude', [], {
    extensions: new Set(['.jsonl']),
    filePredicate: (path) => basename(path) === targetName
  })
  return files[0] ?? null
}

async function resolveCodexSessionFile(
  sessionId: string,
  sessionsDirs: string[]
): Promise<string | null> {
  // Codex rollout file names embed the session id (rollout-<ts>-<id>.jsonl), so
  // match the id as a suffix of the file's base name rather than an exact name.
  // Search each candidate root (managed home first) and stop at the first match.
  for (const sessionsDir of sessionsDirs) {
    if (!existsSync(sessionsDir)) {
      continue
    }
    const files = await walkSessionFiles(sessionsDir, 'codex', [], {
      extensions: new Set(['.jsonl']),
      filePredicate: (path) => {
        const name = basename(path, extname(path))
        return name === sessionId || name.endsWith(`-${sessionId}`)
      }
    })
    if (files[0]) {
      return files[0]
    }
  }
  return null
}
