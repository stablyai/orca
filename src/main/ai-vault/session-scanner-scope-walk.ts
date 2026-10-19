import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { noteAiVaultScanReading } from './ai-vault-scan-progress'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  lookupSessionScopeCwds,
  clearSessionScopeCwdKnowledge,
  pruneSessionScopeCwds,
  resolveSessionScopeCwd,
  storeSessionScopeCwd,
  type SessionScopeCwdStamp
} from './session-parse-cache-store'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { parseSessionCandidates } from './session-scanner-candidate-parse'
import { sessionSortTime } from './session-scanner-accumulator'
import { discoveryFileCandidates, dropCodexHardlinkAliases } from './session-scanner-candidates'
import type { SessionParseStats } from './session-scanner-parse-cache'
import { discoverInScopeCwdBucketFiles } from './session-scanner-scope-discovery'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import { AI_VAULT_SCOPE_CWD_SOURCES, scopeWalksAgentFiles } from './session-scope-cwd'
import { sidecarUnchanged } from './session-sidecar-stat'
import { prioritizeAntigravityTranscriptCandidates } from './antigravity-transcript-candidates'

type ScopeScanArgs = {
  discoveries: readonly SessionFileDiscovery[]
  options: AiVaultScanOptions
  limit: number
  // The capped list's transcripts, already parsed and returned.
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  antigravityWorkspaceResolver: AntigravityWorkspaceResolver
}

/**
 * The Workspace/Project sessions the recency cap left out, for every agent: each
 * one is found the way AI_VAULT_SCOPE_CWD_SOURCES says its cwd can be read.
 */
export async function scanInScopeSessions(args: ScopeScanArgs): Promise<AiVaultSession[]> {
  const scopePaths = args.options.scopePaths ?? []
  if (scopePaths.length === 0) {
    return []
  }
  const candidates: SessionFileCandidate[] = []
  for (const source of Object.values(AI_VAULT_SCOPE_CWD_SOURCES)) {
    if (source.kind !== 'bucket') {
      continue
    }
    const { layout } = source
    const files = await discoverInScopeCwdBucketFiles(layout, {
      rootDirs: args.discoveries
        .filter((discovery) => discovery.agent === layout.agent)
        .map((discovery) => discovery.rootDir),
      scopePaths,
      limit: args.limit,
      excludedFilePaths: args.alreadyParsedFilePaths,
      issues: args.issues
    })
    candidates.push(...files.map((file) => ({ agent: layout.agent, file, codexHome: null })))
  }
  const walked = await walkInScopeSessions(args, scopePaths).finally(clearSessionScopeCwdKnowledge)
  if (candidates.length === 0) {
    return walked
  }
  noteAiVaultScanReading(args.options.signal, candidates.length)
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  const bucketed = await parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.options.signal
  })
  return [...bucketed, ...walked]
}

/**
 * Agents without a cwd-per-directory layout: walks their files newest first,
 * skips a file only when its cached or opening-record cwd is known to be out of
 * scope, and counts what the parse then places in scope.
 */
async function walkInScopeSessions(
  args: ScopeScanArgs,
  scopePaths: readonly string[]
): Promise<AiVaultSession[]> {
  const signal = args.options.signal
  const inScope = createAiVaultScopeCwdMatcher(scopePaths)
  const candidates = walkCandidates(args, scopePaths)
  await lookupScopeCwds(candidates, signal)
  const sessions = await parseSessionCandidates({
    candidates,
    limit: args.limit,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    antigravityWorkspaceResolver: args.antigravityWorkspaceResolver,
    signal,
    listed: false,
    selectCandidate: (candidate) => mayBeInScope(candidate, inScope, args.platform, signal),
    admitSession: (session) => inScope(session.cwd, session.filePath)
  })
  return sessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, args.limit)
}

function walkCandidates(
  args: ScopeScanArgs,
  scopePaths: readonly string[]
): SessionFileCandidate[] {
  const all: SessionFileCandidate[] = []
  const seenPaths = new Set<string>()
  for (const discovery of args.discoveries) {
    if (!scopeWalksAgentFiles(discovery.agent, scopePaths)) {
      continue
    }
    const files: FileWithMtime[] = []
    for (const file of [...discovery.files, ...(discovery.scopeFiles ?? [])]) {
      if (!seenPaths.has(file.path)) {
        seenPaths.add(file.path)
        files.push(file)
      }
    }
    all.push(...discoveryFileCandidates(discovery, files, args.options))
  }
  pruneSessionScopeCwds(seenPaths)
  // Aliases collapse with the listed files still present, so a listed rollout's
  // hardlink in another Codex home is not parsed again.
  return prioritizeAntigravityTranscriptCandidates(
    dropCodexHardlinkAliases(all).filter(
      (candidate) => !args.alreadyParsedFilePaths.has(candidate.file.path)
    ),
    (candidate) => candidate.agent === 'antigravity'
  )
}

// Per lookup batch: one database round trip, then a turn for the event loop.
const SCOPE_LOOKUP_BATCH = 500

async function lookupScopeCwds(
  candidates: readonly SessionFileCandidate[],
  signal: AbortSignal | undefined
): Promise<void> {
  // The Antigravity fold has no cwd until the per-scan history join runs.
  const paths = candidates
    .filter((candidate) => !candidate.antigravityHistoryPath)
    .map((candidate) => candidate.file.path)
  for (let start = 0; start < paths.length; start += SCOPE_LOOKUP_BATCH) {
    throwIfAiVaultScanCancelled(signal)
    lookupSessionScopeCwds(paths.slice(start, start + SCOPE_LOOKUP_BATCH))
    await yieldToEventLoop()
  }
}

/**
 * False only when this transcript version's cwd is known to be out of scope: a
 * parse row's cwd first, then one read without a parse. A read the agent can
 * settle is stored, so the next scan of an unchanged file reads nothing.
 */
async function mayBeInScope(
  candidate: SessionFileCandidate,
  inScope: ReturnType<typeof createAiVaultScopeCwdMatcher>,
  platform: NodeJS.Platform,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const { file } = candidate
  if (candidate.antigravityHistoryPath) {
    return true
  }
  const resolve = () =>
    resolveSessionScopeCwd(file.path, (stamp) => stampMatchesFile(stamp, file, platform))
  let known = resolve()
  const source = AI_VAULT_SCOPE_CWD_SOURCES[candidate.agent]
  if (known === 'read' && source.kind === 'read') {
    const read = await source.readCwd(candidate, signal)
    throwIfAiVaultScanCancelled(signal)
    if (read !== null) {
      storeSessionScopeCwd(file.path, {
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes ?? null,
        platform,
        cwd: read.cwd,
        ...(file.sidecar === undefined ? {} : { sidecar: file.sidecar })
      })
    }
    known = resolve()
  }
  return typeof known === 'string' || (known.cwd !== null && inScope(known.cwd, file.path))
}

function stampMatchesFile(
  stamp: SessionScopeCwdStamp,
  file: FileWithMtime,
  platform: NodeJS.Platform
): boolean {
  return (
    stamp.platform === platform &&
    stamp.mtimeMs === file.mtimeMs &&
    (stamp.sizeBytes === null ||
      file.sizeBytes === undefined ||
      stamp.sizeBytes === file.sizeBytes) &&
    sidecarUnchanged(stamp.sidecar, file.sidecar)
  )
}
