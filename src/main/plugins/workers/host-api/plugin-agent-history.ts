import { z } from 'zod'
import {
  aiVaultSessionInScope,
  createAiVaultScopeCwdMatcher
} from '../../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { PLUGIN_AGENT_SESSION_LIST_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api-agent-history'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

/**
 * The parts of an Agent Session History row the plugin host reads. Previews, prompts and the
 * account home stay behind; `filePath` and `codexHome` stay in main, for resume preparation only.
 */
const historyRow = z.object({
  agent: z.string(),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  cwdAliases: z.array(z.string()).optional(),
  branch: z.string().nullable(),
  filePath: z.string(),
  codexHome: z.string().nullable(),
  executionHostId: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  modifiedAt: z.string(),
  messageCount: z.number(),
  totalTokens: z.number(),
  subagent: z.unknown().nullable().optional()
})
const historyAnswer = z.object({
  sessions: z.array(z.unknown()),
  fingerprint: z.string().optional(),
  unchanged: z.literal(true).optional()
})

export type PluginHistorySession = {
  agent: string
  sessionId: string
  title: string
  cwd: string | null
  cwdAliases?: string[]
  branch: string | null
  filePath: string
  codexHome: string | null
  hostId: string
  createdAt: number | null
  updatedAt: number
  messageCount: number
  totalTokens: number
}

export type PluginHistoryRead = {
  /** Newest first. */
  sessions: readonly PluginHistorySession[]
  /** An unscoped read hit its depth, so older sessions exist that it does not hold. */
  depthReached: boolean
}

function epochMs(value: string | null): number | null {
  const ms = value === null ? Number.NaN : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function toHistorySession(raw: unknown): PluginHistorySession | null {
  const parsed = historyRow.safeParse(raw)
  // Subagent transcripts belong to their parent session, which is the one a plugin resumes.
  if (!parsed.success || parsed.data.subagent) {
    return null
  }
  const row = parsed.data
  return {
    agent: row.agent,
    sessionId: row.sessionId,
    title: row.title,
    cwd: row.cwd,
    ...(row.cwdAliases ? { cwdAliases: row.cwdAliases } : {}),
    branch: row.branch,
    filePath: row.filePath,
    codexHome: row.codexHome,
    hostId: row.executionHostId,
    createdAt: epochMs(row.createdAt),
    updatedAt: epochMs(row.updatedAt) ?? epochMs(row.modifiedAt) ?? 0,
    messageCount: count(row.messageCount),
    totalTokens: count(row.totalTokens)
  }
}

/** How long a read answers every plugin before the next call revalidates it. */
export const PLUGIN_HISTORY_TTL_MS = 30_000
const MAX_CACHED_SCOPES = 16

type ReadState = { settledAt: number | null; fingerprint?: string }
type CachedRead = { read: Promise<PluginHistoryRead>; state: ReadState }
// Why shared and keyed by scope: every plugin sees the same history, and each read scans transcript
// folders. Plugins polling together share one read in flight and its answer for the TTL; after it,
// the vault's fingerprint tells whether the rows changed, so an unchanged history is not re-parsed.
// Keyed by the runtime RPC the reads went through.
const reads = new WeakMap<PluginRuntimeRpc, Map<string, CachedRead>>()

async function readHistory(
  call: PluginRuntimeRpc,
  scopePath: string | null,
  previous: { fingerprint: string; value: PluginHistoryRead } | null
): Promise<{ value: PluginHistoryRead; fingerprint?: string }> {
  const answer = historyAnswer.parse(
    await call('aiVault.listSessions', {
      // One depth for every caller, so all plugins share the vault's cached scan.
      limit: PLUGIN_AGENT_SESSION_LIST_LIMIT,
      ...(scopePath ? { scopePaths: [scopePath], scopeOnly: true } : {}),
      // Null asks for this answer's fingerprint, which the next read revalidates with.
      afterFingerprint: previous?.fingerprint ?? null
    })
  )
  if (answer.unchanged && previous && answer.fingerprint === previous.fingerprint) {
    return { value: previous.value, fingerprint: previous.fingerprint }
  }
  if (answer.unchanged) {
    // A reply about some other body cannot stand in for rows this host no longer holds.
    return readHistory(call, scopePath, null)
  }
  const sessions = answer.sessions
    .map(toHistorySession)
    .filter((row): row is PluginHistorySession => row !== null)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
  return {
    value: {
      sessions,
      depthReached: !scopePath && answer.sessions.length >= PLUGIN_AGENT_SESSION_LIST_LIMIT
    },
    ...(answer.fingerprint ? { fingerprint: answer.fingerprint } : {})
  }
}

function startRead(
  call: PluginRuntimeRpc,
  scopePath: string | null,
  stale: CachedRead | undefined
): CachedRead {
  const state: ReadState = { settledAt: null }
  const read = (async () => {
    const fingerprint = stale?.state.fingerprint
    // The stale read has settled: it is past its TTL.
    const value = fingerprint ? await stale.read.catch(() => null) : null
    const result = await readHistory(
      call,
      scopePath,
      fingerprint && value ? { fingerprint, value } : null
    )
    state.fingerprint = result.fingerprint
    state.settledAt = Date.now()
    return result.value
  })()
  return { read, state }
}

/**
 * This computer's Agent Session History, all of it (`scopePath` null) or one folder's. `owner` is
 * the runtime RPC `call` wraps, which keys the shared reads.
 */
export function pluginAgentHistory(
  call: PluginRuntimeRpc,
  owner: PluginRuntimeRpc,
  scopePath: string | null
): Promise<PluginHistoryRead> {
  let scopes = reads.get(owner)
  if (!scopes) {
    scopes = new Map()
    reads.set(owner, scopes)
  }
  const key = scopePath ?? ''
  const cached = scopes.get(key)
  if (
    cached &&
    (cached.state.settledAt === null || Date.now() - cached.state.settledAt < PLUGIN_HISTORY_TTL_MS)
  ) {
    return cached.read
  }
  const entry = startRead(call, scopePath, cached)
  scopes.delete(key)
  scopes.set(key, entry)
  // Bounded: the scope read longest ago goes first.
  for (const oldest of scopes.keys()) {
    if (scopes.size <= MAX_CACHED_SCOPES) {
      break
    }
    scopes.delete(oldest)
  }
  const owned = scopes
  entry.read.catch(() => {
    // A failed read is not kept: the next call asks again.
    if (owned.get(key) === entry) {
      owned.delete(key)
    }
  })
  return entry.read
}

/** A workspace a session may have run in: its public id, host and folder. */
export type PluginHistoryWorkspace = { id: string; hostId: string | null; path: string }

/** Whether a workspace row lives on this computer, where its history is read. */
export function isLocalHistoryWorkspace(row: Pick<PluginHistoryWorkspace, 'hostId'>): boolean {
  return row.hostId === null || row.hostId === LOCAL_EXECUTION_HOST_ID
}

/**
 * The workspace each session ran in: the deepest of this computer's workspaces holding its
 * folder, so a worktree nested in its project's folder claims its own sessions. SSH and runtime
 * hosts' workspaces never match: a same-named folder there is another machine's.
 */
export function pluginHistoryWorkspaceMatcher(
  workspaces: readonly PluginHistoryWorkspace[]
): (
  session: Pick<PluginHistorySession, 'cwd' | 'cwdAliases' | 'filePath' | 'hostId'>
) => string | null {
  const candidates = workspaces
    .filter(isLocalHistoryWorkspace)
    .map((row) => ({
      id: row.id,
      depth: normalizeRuntimePathForComparison(row.path).length,
      inScope: createAiVaultScopeCwdMatcher([row.path])
    }))
    .toSorted((a, b) => b.depth - a.depth)
  return (session) => {
    if (session.hostId !== LOCAL_EXECUTION_HOST_ID) {
      return null
    }
    return candidates.find((row) => aiVaultSessionInScope(row.inScope, session))?.id ?? null
  }
}
