import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat-agent-support'
import { isWslUncPath } from '../../shared/wsl-paths'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import {
  claudeProjectsHostDirs,
  codexHomeSessionsDir,
  uniqueDirs
} from '../ai-vault/session-scanner-roots'
import { resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import {
  findGrokChatHistoryBySessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'
import {
  needsWslHostResolution,
  toHostReadableTranscriptPath,
  wslAgentSessionsDirs
} from './host-readable-transcript-path'
import { SESSION_FILE_ID_LAYOUTS, type SessionIdLookupAgent } from './session-file-id-layouts'
import { findWslSessionPath } from './wsl-session-path-scan'
import { parseSshTranscriptPath } from './ssh-transcript-path'
import { wslTranscriptFsRefusal, type WslTranscriptFsError } from './wsl-transcript-fs-gate'

// Why: roots come from the shared table AI Vault discovery reads, computed per
// call so they track the live home. An earlier root wins: that is what keeps one
// account's transcript from resolving to another's.
function claudeProjectsDirs(): string[] {
  return uniqueDirs([...claudeProjectsHostDirs(), ...claudeProfileHistoryDirs('projects')])
}

// Why: Orca launches Codex with its own managed CODEX_HOME, so Orca-started rollouts
// land there; search it first, then CODEX_HOME/~/.codex for non-Orca sessions.
// WSL roots are a separate lazy tier — see resolveCodexSessionFile.
// resolveOrcaManagedCodexHomePath avoids the getter's mkdirSync; creating the
// runtime home belongs to launch, not this resolve poll.
function codexSessionsDirs(): string[] {
  return uniqueDirs([join(resolveOrcaManagedCodexHomePath(), 'sessions'), codexHomeSessionsDir()])
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
  /** Override the omp sessions root (`~/.omp/agent/sessions`). */
  ompSessionsDir?: string
  /** Authoritative transcript path reported by the agent hook
   *  (`providerSession.transcriptPath`). When set and the file exists, it is used
   *  directly — recent Claude Code names the transcript with a UUID that differs
   *  from the hook session_id, so the id-based glob below would miss it. */
  transcriptPath?: string
  /** Attested WSL provider-session distro. Restricts exact-path resolution to that guest. */
  wslDistro?: string
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
  if (!transcriptAgent || transcriptAgent === 'opencode') {
    return null
  }
  // Why: the hook's transcript_path is the exact file the agent is writing, so it
  // beats reconstructing a path from the session id. Route it through the host
  // readability check so a WSL guest path becomes an openable UNC on Windows;
  // stale/missing paths fall through to the id-based search.
  let unavailable: WslTranscriptFsError | undefined
  const hookPath = options.transcriptPath?.trim()
  // An SSH host's transcript is read only where its hook said; never search this machine for it.
  if (hookPath && parseSshTranscriptPath(hookPath)) {
    return extname(hookPath) === '.jsonl' ? hookPath : null
  }
  if (hookPath && extname(hookPath) === '.jsonl') {
    try {
      const hostReadable = await toHostReadableTranscriptPath(hookPath, {
        signal,
        wslDistro: options.wslDistro
      })
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

  // A guest/UNC hook path is authoritative even when the provider did not
  // attest a distro. Never let its session id resolve to a host or other guest
  // transcript after that exact path misses.
  if (hookPath && needsWslHostResolution(hookPath)) {
    if (unavailable) {
      throw unavailable
    }
    return null
  }

  // A WSL worker may fall back to terminal evidence, but never to an id match on
  // the host or another distro after its attested exact path misses.
  if (options.wslDistro?.trim()) {
    if (unavailable) {
      throw unavailable
    }
    return null
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
  if (transcriptAgent === 'opencode') {
    return null
  }
  const trimmedId = sessionId.trim()
  if (!trimmedId) {
    return null
  }

  // An explicit root is the caller naming the exact tree its session pinned; adding
  // a fallback there (another root or a distro) could resolve a different account's
  // transcript, so overrides get no WSL tier.
  if (transcriptAgent === 'claude') {
    const override = options.claudeProjectsDir
    return resolveTiered('claude', trimmedId, override ? [override] : claudeProjectsDirs(), {
      wslTier: !override,
      signal
    })
  }
  if (transcriptAgent === 'codex') {
    const override = options.codexSessionsDirs
    return resolveTiered('codex', trimmedId, override ?? codexSessionsDirs(), {
      wslTier: !override,
      signal
    })
  }
  if (transcriptAgent === 'grok') {
    const override = options.grokSessionsDir
    return resolveTiered('grok', trimmedId, [override ?? grokSessionsDir()], {
      wslTier: !override,
      signal
    })
  }
  if (transcriptAgent === 'omp') {
    const override = options.ompSessionsDir
    const root = resolveOmpSessionsDir({ sessionsDir: override })
    return resolveTiered('omp', trimmedId, root ? [root] : [], {
      wslTier: override === undefined,
      signal
    })
  }
  // Why: a new transcript agent must pick its own resolver. Falling through to
  // OMP's scan would search the wrong root with a foreign session id, so fail
  // the build here instead of resolving silently wrong at runtime.
  transcriptAgent satisfies never
  return null
}

/**
 * Search this host's roots in order (an earlier root wins), then — only on a miss —
 * each running WSL distro's roots for the same agent.
 */
async function resolveTiered(
  agent: SessionIdLookupAgent,
  sessionId: string,
  hostDirs: readonly string[],
  options: { wslTier: boolean; signal?: AbortSignal }
): Promise<string | null> {
  const { signal } = options
  const hit = await findFirstInDirs(agent, sessionId, hostDirs, signal)
  if (hit || !options.wslTier) {
    return hit
  }
  signal?.throwIfAborted()
  // Why: enumerating WSL homes spawns wsl.exe per distro, which boots ones the
  // user left stopped. Only pay that after this host's own roots miss (#10326, #13789).
  const wslDirs = (await wslAgentSessionsDirs(agent)).filter((dir) => !hostDirs.includes(dir))
  signal?.throwIfAborted()
  return findFirstInDirs(agent, sessionId, wslDirs, signal)
}

async function findFirstInDirs(
  agent: SessionIdLookupAgent,
  sessionId: string,
  dirs: readonly string[],
  signal?: AbortSignal
): Promise<string | null> {
  let unavailable: WslTranscriptFsError | undefined
  for (const dir of dirs) {
    try {
      const hit = isWslUncPath(dir)
        ? await findWslSessionPath(agent, dir, sessionId, signal)
        : await findHostSessionFile(agent, dir, sessionId, signal)
      if (hit) {
        return hit
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

async function findHostSessionFile(
  agent: SessionIdLookupAgent,
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (agent === 'grok') {
    // Why: Native Chat runs on the main thread; use the bounded async direct-layout
    // lookup instead of a recursive full-tree scan.
    signal?.throwIfAborted()
    const history = await findGrokChatHistoryBySessionId(root, sessionId)
    signal?.throwIfAborted()
    return history
  }
  const { fileMatchesId, directoryPredicate } = SESSION_FILE_ID_LAYOUTS[agent]
  const wanted = (id: string): boolean => id === sessionId
  // No existence pre-check: the walk yields [] for a missing root, and a sync
  // probe would block the main thread.
  const files = await walkSessionFiles(root, agent, [], {
    extensions: new Set(['.jsonl']),
    filePredicate: (path) => fileMatchesId(path, sessionId),
    directoryPredicate: directoryPredicate
      ? (name, depth) => directoryPredicate(name, depth, wanted)
      : undefined,
    signal
  })
  return files[0] ?? null
}
