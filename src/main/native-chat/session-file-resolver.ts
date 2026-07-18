import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  CODEX_SESSION_ROLLOUT_EXTENSIONS,
  codexRolloutBaseName,
  isCodexSessionRolloutPath
} from '../ai-vault/session-scanner-codex-paths'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import {
  findGrokChatHistoryBySessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'

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

function grokSessionsDir(): string {
  return resolveGrokSessionsDir(process.env, homedir())
}

export type ResolveSessionFileOptions = {
  /** Override the Claude projects root (used by tests / isolated scans). */
  claudeProjectsDir?: string
  /** Override the Codex sessions roots, searched in order (tests / isolated
   *  scans). Defaults to the orca-managed home then CODEX_HOME/~/.codex. */
  codexSessionsDirs?: string[]
  /** Override the Grok sessions root (`~/.grok/sessions`). */
  grokSessionsDir?: string
  /** Authoritative transcript path reported by the agent hook
   *  (`providerSession.transcriptPath`). When set and the file exists, it is used
   *  directly — recent Claude Code names the transcript with a UUID that differs
   *  from the hook session_id, so the id-based glob below would miss it. */
  transcriptPath?: string
  /** Require a client-provided transcript path to resolve inside this agent's
   *  transcript roots. Runtime RPC enables this for untrusted paired clients. */
  requireTranscriptPathInAgentRoots?: boolean
}

function agentTranscriptRoots(agent: AgentType, options: ResolveSessionFileOptions): string[] {
  if (agent === 'claude') {
    return [options.claudeProjectsDir ?? claudeProjectsDir()]
  }
  if (agent === 'codex') {
    return options.codexSessionsDirs ?? codexSessionsDirs()
  }
  if (agent === 'grok') {
    return [options.grokSessionsDir ?? grokSessionsDir()]
  }
  return []
}

async function resolveContainedPath(
  filePath: string,
  roots: readonly string[]
): Promise<string | null> {
  let resolvedFile: string
  try {
    resolvedFile = await realpath(filePath)
  } catch {
    return null
  }

  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root)
      const relativePath = relative(resolvedRoot, resolvedFile)
      if (
        relativePath === '' ||
        (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
      ) {
        // Return the canonical path so a symlink cannot be swapped after validation.
        return resolvedFile
      }
    } catch {
      // Missing roots cannot contain an existing transcript; try the next root.
    }
  }
  return null
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
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (!transcriptAgent) {
    return null
  }
  // Why: the hook's transcript_path is the exact file the agent is writing, so it
  // beats reconstructing a path from the session id. Guard with existsSync so a
  // stale/remote path falls through to the id-based search rather than returning
  // a non-existent file.
  const hookPath = options.transcriptPath?.trim()
  const hookPathIsTranscript =
    extname(hookPath ?? '') === '.jsonl' ||
    (agent === 'codex' && Boolean(hookPath && isCodexSessionRolloutPath(hookPath)))
  if (hookPath && hookPathIsTranscript) {
    if (options.requireTranscriptPathInAgentRoots) {
      const containedPath = await resolveContainedPath(
        hookPath,
        agentTranscriptRoots(agent, options)
      )
      if (containedPath) {
        return containedPath
      }
    } else if (existsSync(hookPath)) {
      return hookPath
    }
  }

  const trimmedId = sessionId.trim()
  if (!trimmedId) {
    return null
  }

  if (transcriptAgent === 'claude') {
    return resolveClaudeSessionFile(trimmedId, options.claudeProjectsDir ?? claudeProjectsDir())
  }
  if (transcriptAgent === 'codex') {
    return resolveCodexSessionFile(trimmedId, options.codexSessionsDirs ?? codexSessionsDirs())
  }
  if (transcriptAgent === 'grok') {
    return resolveGrokSessionFile(trimmedId, options.grokSessionsDir ?? grokSessionsDir())
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
  // Codex rollout file names embed the session id. Prefer plain `.jsonl` when
  // both it and a cold `.jsonl.zst` sibling exist.
  // Search each candidate root (managed home first) and stop at the first match.
  for (const sessionsDir of sessionsDirs) {
    if (!existsSync(sessionsDir)) {
      continue
    }
    const files = await walkSessionFiles(sessionsDir, 'codex', [], {
      extensions: new Set(CODEX_SESSION_ROLLOUT_EXTENSIONS),
      filePredicate: (path) => {
        if (!isCodexSessionRolloutPath(path)) {
          return false
        }
        const name = codexRolloutBaseName(path)
        return name === sessionId || name.endsWith(`-${sessionId}`)
      }
    })
    if (files.length > 0) {
      return files.find((path) => path.endsWith('.jsonl')) ?? files[0] ?? null
    }
  }
  return null
}

async function resolveGrokSessionFile(
  sessionId: string,
  sessionsDir: string
): Promise<string | null> {
  // Why: Native Chat runs on the main thread; use the bounded async direct-layout
  // lookup instead of blocking, then repeating, a recursive full-tree scan.
  const history = await findGrokChatHistoryBySessionId(sessionsDir, sessionId)
  return history
}
