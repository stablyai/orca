import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat-agent-support'
import { isWslUncPath } from '../../shared/wsl-paths'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { OMP_SESSION_ARTIFACT_DIR_PATTERN } from '../ai-vault/session-scanner-omp-subagent-transcripts'
import { normalizeAgentSessionsDir } from '../ai-vault/session-scanner-values'
import { resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import {
  findGrokChatHistoryBySessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'
import { toHostReadableTranscriptPath, wslCodexSessionsDirs } from './host-readable-transcript-path'
import { findWslCodexSessionPath } from './wsl-codex-session-path-scan'
import { wslTranscriptFsRefusal, type WslTranscriptFsError } from './wsl-transcript-fs-gate'

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
// WSL roots are a separate lazy tier — see resolveCodexSessionFile.
// Why: resolveOrcaManagedCodexHomePath avoids the mkdirSync performed by the
// getter; creating the runtime home belongs to launch, not this resolve poll.
function codexSessionsDirs(): string[] {
  const candidates = [
    join(resolveOrcaManagedCodexHomePath(), 'sessions'),
    join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions')
  ]
  return candidates.filter((dir, index) => candidates.indexOf(dir) === index)
}

function grokSessionsDir(): string {
  return resolveGrokSessionsDir(process.env, homedir())
}

/** Mirrors the AI Vault scanner so an OMP_CODING_AGENT_DIR override resolves the
 *  same root for both, rather than leaving native chat pointed at the default. */
function ompSessionsDir(): string {
  return normalizeAgentSessionsDir(
    process.env.OMP_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent', 'sessions'),
    '.omp'
  )
}

export type ResolveSessionFileOptions = {
  /** Override the Claude projects root (used by tests / isolated scans). */
  claudeProjectsDir?: string
  /** Override the Codex sessions roots, searched in order (tests / isolated
   *  scans). Defaults to the orca-managed home then CODEX_HOME/~/.codex. */
  codexSessionsDirs?: string[]
  /** Override the Grok sessions root (`~/.grok/sessions`). */
  grokSessionsDir?: string
  /** Override the omp sessions root (`~/.omp/agent/sessions`). */
  ompSessionsDir?: string
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
  options: ResolveSessionFileOptions = {},
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (!transcriptAgent) {
    return null
  }
  // Why: the hook's transcript_path is the exact file the agent is writing, so it
  // beats reconstructing a path from the session id. Route it through the host
  // readability check so a WSL guest path becomes an openable UNC on Windows;
  // stale/missing paths fall through to the id-based search.
  let unavailable: WslTranscriptFsError | undefined
  const hookPath = options.transcriptPath?.trim()
  if (hookPath && extname(hookPath) === '.jsonl') {
    try {
      const hostReadable = await toHostReadableTranscriptPath(hookPath, { signal })
      if (hostReadable) {
        return hostReadable
      }
    } catch (error) {
      // A caller abort that races the refusal stays authoritative.
      signal?.throwIfAborted()
      // Why: the id-based search may still hit; surface the refusal only when
      // it does not, so a stalled distro reads as unavailable, never "missing".
      unavailable = wslTranscriptFsRefusal(error)
    }
  }

  const resolved = await resolveSessionFileById(transcriptAgent, sessionId, options, signal)
  if (!resolved && unavailable) {
    throw unavailable
  }
  return resolved
}

async function resolveSessionFileById(
  transcriptAgent: NativeChatTranscriptAgent,
  sessionId: string,
  options: ResolveSessionFileOptions,
  signal?: AbortSignal
): Promise<string | null> {
  const trimmedId = sessionId.trim()
  if (!trimmedId) {
    return null
  }

  if (transcriptAgent === 'claude') {
    return resolveClaudeSessionFile(
      trimmedId,
      options.claudeProjectsDir ?? claudeProjectsDir(),
      signal
    )
  }
  if (transcriptAgent === 'codex') {
    const overrideDirs = options.codexSessionsDirs
    return resolveCodexSessionFile(
      trimmedId,
      overrideDirs ?? codexSessionsDirs(),
      // Why: enumerating WSL homes spawns wsl.exe per distro, which boots ones the
      // user left stopped. Only pay that after this host's own Codex roots miss.
      overrideDirs ? undefined : wslCodexSessionsDirs,
      signal
    )
  }
  if (transcriptAgent === 'grok') {
    return resolveGrokSessionFile(trimmedId, options.grokSessionsDir ?? grokSessionsDir(), signal)
  }
  if (transcriptAgent === 'omp') {
    return resolveOmpSessionFile(trimmedId, options.ompSessionsDir ?? ompSessionsDir(), signal)
  }
  // Why: a new transcript agent must pick its own resolver. Falling through to
  // OMP's scan would search the wrong root with a foreign session id, so fail
  // the build here instead of resolving silently wrong at runtime.
  transcriptAgent satisfies never
  return null
}

async function resolveClaudeSessionFile(
  sessionId: string,
  projectsDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  const targetName = `${sessionId}.jsonl`
  const files = await walkSessionFiles(projectsDir, 'claude', [], {
    extensions: new Set(['.jsonl']),
    filePredicate: (path) => basename(path) === targetName,
    signal
  })
  return files[0] ?? null
}

async function resolveCodexSessionFile(
  sessionId: string,
  sessionsDirs: string[],
  loadFallbackDirs?: () => Promise<string[]>,
  signal?: AbortSignal
): Promise<string | null> {
  // Codex rollout file names embed the session id (rollout-<ts>-<id>.jsonl), so
  // match the id as a suffix of the file's base name rather than an exact name.
  // Search each candidate root (managed home first) and stop at the first match.
  const hit = await findCodexRolloutInDirs(sessionId, sessionsDirs, signal)
  if (hit) {
    return hit
  }
  if (!loadFallbackDirs) {
    return null
  }
  signal?.throwIfAborted()
  // Why: a WSL-hosted session's rollout only exists inside the distro, so fall
  // back to each distro's Codex homes when the host's own roots came up empty (#10326).
  const fallbackDirs = (await loadFallbackDirs()).filter((dir) => !sessionsDirs.includes(dir))
  signal?.throwIfAborted()
  return findCodexRolloutInDirs(sessionId, fallbackDirs, signal)
}

async function findCodexRolloutInDirs(
  sessionId: string,
  sessionsDirs: string[],
  signal?: AbortSignal
): Promise<string | null> {
  let unavailable: WslTranscriptFsError | undefined
  for (const sessionsDir of sessionsDirs) {
    // Why: no existence pre-check — walkSessionFiles already yields [] for a
    // missing/unreadable root, and a sync probe would block the main thread on a
    // `\\wsl.localhost` root whose distro is stopped.
    const scanOptions = {
      extensions: new Set(['.jsonl']),
      filePredicate: (path: string): boolean => {
        const name = basename(path, extname(path))
        return name === sessionId || name.endsWith(`-${sessionId}`)
      }
    }
    const isWslRoot = isWslUncPath(sessionsDir)
    try {
      const files = isWslRoot
        ? await findWslCodexSessionPath(sessionsDir, sessionId, signal)
        : (
            await walkSessionFiles(sessionsDir, 'codex', [], {
              ...scanOptions,
              signal
            })
          )[0]
      if (files) {
        return files
      }
    } catch (error) {
      // A caller abort that races the refusal stays authoritative.
      signal?.throwIfAborted()
      // Why: one stalled distro must not hide another root's hit.
      unavailable = wslTranscriptFsRefusal(error)
    }
  }
  // No hit and at least one root never scanned: "couldn't look", not "missing".
  if (unavailable) {
    throw unavailable
  }
  return null
}

async function resolveGrokSessionFile(
  sessionId: string,
  sessionsDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  // Why: Native Chat runs on the main thread; use the bounded async direct-layout
  // lookup instead of blocking, then repeating, a recursive full-tree scan.
  signal?.throwIfAborted()
  const history = await findGrokChatHistoryBySessionId(sessionsDir, sessionId)
  signal?.throwIfAborted()
  return history
}

// omp keeps one directory per working directory (`-Documents-dog-app`) with the
// transcript inside it, named `<ISO timestamp>_<session id>.jsonl` — so match the
// id as a base-name suffix, the way Codex rollout files are matched, and let the
// walk cover the per-cwd subdirectories.
async function resolveOmpSessionFile(
  sessionId: string,
  sessionsDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  const files = await walkSessionFiles(sessionsDir, 'omp', [], {
    extensions: new Set(['.jsonl']),
    // Why: a session's task-subagent transcripts live in its same-named
    // `<stamp>_<uuid>/` artifact dir, and a label-named child can still end in
    // `_<session id>` — so descending would let a subagent transcript win the
    // suffix match over its own parent. Prune the subtree exactly as the AI
    // Vault scanner does (session-scanner-source-discovery.ts): it keeps the
    // walk at one readdir per workspace dir regardless of how much the session
    // delegated. Depth 0 is the workspace dir, which is never an artifact dir.
    directoryPredicate: (name, depth) =>
      depth === 0 || !OMP_SESSION_ARTIFACT_DIR_PATTERN.test(name),
    filePredicate: (path) => {
      const name = basename(path, extname(path))
      return name === sessionId || name.endsWith(`_${sessionId}`)
    },
    signal
  })
  return files[0] ?? null
}
