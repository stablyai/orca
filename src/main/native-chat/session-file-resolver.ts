import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import {
  resolveNativeChatTranscriptAgent,
  type NativeChatTranscriptAgent
} from '../../shared/native-chat/native-chat-agent-support'
import { isWslUncPath } from '../../shared/wsl-paths'
import { forEachSessionFile } from '../ai-vault/session-scanner-discovery'
import { resolveOmpSessionsDir } from '../ai-vault/scanners/omp/omp-session-root'
import {
  claudeProjectsHostDirs,
  codexHomeSessionsDir,
  uniqueDirs
} from '../ai-vault/session-scanner-roots'
import { resolveOrcaManagedCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import {
  findGrokChatHistoryBySessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'
import {
  hostAdditionalCodexHomePaths,
  needsWslHostResolution,
  toHostReadableTranscriptPath,
  wslAgentSessionsDirs
} from './host-readable-transcript-path'
import { SESSION_FILE_ID_LAYOUTS, type SessionIdLookupAgent } from './session-file-id-layouts'
import { findWslSessionPath } from './wsl-session-path-scan'
import { findClaudeSessionFile } from './session-file-resolver-claude-probe'
import { parseSshTranscriptPath } from './ssh-transcript-path'
import { wslTranscriptFsRefusal, type WslTranscriptFsError } from './wsl-transcript-fs-gate'

// Read shared discovery roots per call; preference order prevents cross-account matches.
function claudeProjectsDirs(): string[] {
  return uniqueDirs([...claudeProjectsHostDirs(), ...claudeProfileHistoryDirs('projects')])
}

// Search managed Codex before user homes; use the path-only getter to avoid launch-time mkdirSync on polls.
function codexSessionsDirs(): string[] {
  return uniqueDirs([join(resolveOrcaManagedCodexHomePath(), 'sessions'), codexHomeSessionsDir()])
}

// Enumerate account homes only after common roots miss to avoid unnecessary disk work.
function codexAccountSessionsDirs(): string[] {
  try {
    return hostAdditionalCodexHomePaths().map((home) => join(home, 'sessions'))
  } catch (error) {
    // Account enumeration failure must still allow the WSL tier.
    console.warn('[session-file-resolver] could not list Codex account homes:', error)
    return []
  }
}

function grokSessionsDir(): string {
  return resolveGrokSessionsDir(process.env, homedir())
}

export type ResolveSessionFileOptions = {
  strictErrors?: boolean
  claudeProjectsDir?: string
  /** Claude only: probe this cwd's project bucket first in each root. */
  cwd?: string
  /** Defaults to managed Codex then CODEX_HOME/~/.codex, in order. */
  codexSessionsDirs?: string[]
  grokSessionsDir?: string
  ompSessionsDir?: string
  /** Hook paths are authoritative: Claude filenames may differ from its reported session ID. */
  transcriptPath?: string
  /** Restrict exact-path resolution to this attested guest. */
  wslDistro?: string
}

/** Prefer hook paths, then provider-specific ID lookup; null means no matching transcript. */
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
  let unavailable: WslTranscriptFsError | undefined
  const hookPath = options.transcriptPath?.trim()
  const jsonlHookPath = hookPath && extname(hookPath) === '.jsonl' ? hookPath : undefined
  // SSH paths are readable only on their attested host; never fall back to this machine.
  if (hookPath && parseSshTranscriptPath(hookPath)) {
    return jsonlHookPath ?? null
  }
  if (jsonlHookPath) {
    try {
      const hostReadable = await toHostReadableTranscriptPath(jsonlHookPath, {
        signal,
        wslDistro: options.wslDistro
      })
      if (hostReadable) {
        return hostReadable
      }
    } catch (error) {
      signal?.throwIfAborted()
      // Preserve incomplete-probe refusal unless ID lookup finds a valid hit.
      unavailable = wslTranscriptFsRefusal(error)
    }
  }

  // Guest hook paths remain authoritative without attestation; never cross to host/other-distro ID matches.
  if (hookPath && needsWslHostResolution(hookPath)) {
    if (unavailable) {
      throw unavailable
    }
    return null
  }

  // Attested WSL sessions cannot fall back to host or other-distro ID matches.
  if (options.wslDistro?.trim()) {
    if (unavailable) {
      throw unavailable
    }
    return null
  }

  // Host hook paths prove a host-launched agent, so its transcript cannot be in a guest.
  const wslTier = !jsonlHookPath
  const resolved = await resolveSessionFileById(
    transcriptAgent,
    sessionId,
    options,
    wslTier,
    signal
  )
  if (!resolved && unavailable) {
    throw unavailable
  }
  return resolved
}

async function resolveSessionFileById(
  transcriptAgent: NativeChatTranscriptAgent,
  sessionId: string,
  options: ResolveSessionFileOptions,
  wslTier: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  if (transcriptAgent === 'opencode') {
    return null
  }
  const trimmedId = sessionId.trim()
  if (!trimmedId) {
    return null
  }

  // Explicit roots pin an account; fallback could silently read another account’s transcript.
  if (transcriptAgent === 'claude') {
    const override = options.claudeProjectsDir
    return resolveTiered('claude', trimmedId, override ? [override] : claudeProjectsDirs(), {
      wslTier: wslTier && !override,
      cwd: options.cwd,
      signal,
      strictErrors: options.strictErrors
    })
  }
  if (transcriptAgent === 'codex') {
    const override = options.codexSessionsDirs
    return resolveTiered('codex', trimmedId, override ?? codexSessionsDirs(), {
      wslTier: wslTier && !override,
      ...(override ? {} : { accountDirs: codexAccountSessionsDirs }),
      signal,
      strictErrors: options.strictErrors
    })
  }
  if (transcriptAgent === 'grok') {
    const override = options.grokSessionsDir
    return resolveTiered('grok', trimmedId, [override ?? grokSessionsDir()], {
      wslTier: wslTier && !override,
      signal,
      strictErrors: options.strictErrors
    })
  }
  if (transcriptAgent === 'omp') {
    const override = options.ompSessionsDir
    const root = resolveOmpSessionsDir({ sessionsDir: override })
    return resolveTiered('omp', trimmedId, root ? [root] : [], {
      wslTier: wslTier && override === undefined,
      signal,
      strictErrors: options.strictErrors
    })
  }
  transcriptAgent satisfies never
  return null
}

/** Search preferred host roots, account roots, then running WSL distros. */
async function resolveTiered(
  agent: SessionIdLookupAgent,
  sessionId: string,
  hostDirs: readonly string[],
  options: {
    wslTier: boolean
    accountDirs?: () => readonly string[]
    cwd?: string
    signal?: AbortSignal
    strictErrors?: boolean
  }
): Promise<string | null> {
  const { signal } = options
  const hit = await findFirstInDirs(agent, sessionId, hostDirs, options)
  if (hit) {
    return hit
  }
  const accountDirs = (options.accountDirs?.() ?? []).filter((dir) => !hostDirs.includes(dir))
  const accountHit = await findFirstInDirs(agent, sessionId, accountDirs, options)
  if (accountHit || !options.wslTier) {
    return accountHit
  }
  signal?.throwIfAborted()
  // Defer WSL process/filesystem discovery until host roots miss.
  const wslDirs = (await wslAgentSessionsDirs(agent)).filter((dir) => !hostDirs.includes(dir))
  signal?.throwIfAborted()
  return findFirstInDirs(agent, sessionId, wslDirs, options)
}

type HostLookupOptions = { cwd?: string; signal?: AbortSignal; strictErrors?: boolean }

// Each root finishes (cwd bucket, then every bucket) before the next, so account order still wins.
async function findFirstInDirs(
  agent: SessionIdLookupAgent,
  sessionId: string,
  dirs: readonly string[],
  options: HostLookupOptions
): Promise<string | null> {
  const { signal, strictErrors } = options
  let unavailable: WslTranscriptFsError | undefined
  for (const dir of dirs) {
    try {
      const hit = isWslUncPath(dir)
        ? await findWslSessionPath(agent, dir, sessionId, signal)
        : await findHostSessionFile(agent, dir, sessionId, options)
      if (hit) {
        return hit
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (strictErrors) {
        throw error
      }
      unavailable = wslTranscriptFsRefusal(error)
    }
  }
  // An incomplete scan cannot prove absence.
  if (unavailable) {
    throw unavailable
  }
  return null
}

async function findHostSessionFile(
  agent: SessionIdLookupAgent,
  root: string,
  sessionId: string,
  options: HostLookupOptions
): Promise<string | null> {
  const { signal, strictErrors } = options
  if (agent === 'grok' && !strictErrors) {
    // Bound main-thread work with direct-layout async lookup rather than a recursive scan.
    signal?.throwIfAborted()
    const history = await findGrokChatHistoryBySessionId(root, sessionId)
    signal?.throwIfAborted()
    return history
  }
  if (agent === 'claude') {
    return findClaudeSessionFile(root, sessionId, options)
  }
  const { fileMatchesId, directoryPredicate } = SESSION_FILE_ID_LAYOUTS[agent]
  const wanted = (id: string): boolean => id === sessionId
  // An id names one file, so the walk stops at the first match through its own abort reason.
  const found = new AbortController()
  let hit: string | null = null
  try {
    // The walk handles missing roots; synchronous existence probes would block the main thread.
    await forEachSessionFile(
      root,
      agent,
      [],
      {
        extensions: new Set(['.jsonl']),
        filePredicate: (path) => fileMatchesId(path, sessionId),
        directoryPredicate: directoryPredicate
          ? (name, depth) => directoryPredicate(name, depth, wanted)
          : undefined,
        signal: signal ? AbortSignal.any([signal, found.signal]) : found.signal,
        strictErrors
      },
      (path) => {
        hit ??= path
        found.abort()
      }
    )
  } catch (error) {
    if (hit === null || signal?.aborted) {
      throw error
    }
  }
  signal?.throwIfAborted()
  return hit
}
