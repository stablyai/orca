import { SCAN_ISSUE_LIMIT } from './session-scan-issues'
import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
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
import {
  inventoryCwdBucketFiles,
  selectCwdBucketFiles,
  yieldScanInventory,
  type CwdBucketInventory
} from './session-scanner-scope-inventory'
import { aiVaultScanWorkload, noteAiVaultScanWorkChanged } from './ai-vault-scan-progress'
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
  inventory: CwdBucketInventory[]
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
  const workload = aiVaultScanWorkload(args.options.signal)
  for (const inventory of args.inventory) {
    const files = await selectCwdBucketFiles(inventory, {
      scopePaths,
      limit: args.limit,
      excludedFilePaths: args.alreadyParsedFilePaths,
      issues: args.issues,
      signal: args.options.signal
    })
    const selected = new Set(files.map((file) => file.path))
    let index = 0
    for (const path of workload?.bucketPaths(inventory.layout.agent) ?? []) {
      await yieldScanInventory(index++, args.options.signal)
      if (!selected.has(path)) {
        workload?.settlePath(inventory.layout.agent, path, 'bucket', false)
      }
    }
    for (const file of files) {
      candidates.push({ agent: inventory.layout.agent, file, codexHome: null })
    }
  }
  args.inventory.length = 0
  noteAiVaultScanWorkChanged(args.options.signal)
  const walked = await walkInScopeSessions(args, scopePaths).finally(clearSessionScopeCwdKnowledge)
  if (candidates.length === 0) {
    return walked
  }
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  const bucketed = await parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.options.signal,
    settled: (candidate, parsed) => workload?.settle(candidate, 'bucket', parsed)
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
  const candidates = await walkCandidates(args, scopePaths)
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
    settled: (candidate, parsed) => aiVaultScanWorkload(signal)?.settle(candidate, 'walk', parsed),
    selectCandidate: (candidate) => mayBeInScope(candidate, inScope, args.platform, signal),
    admitSession: (session) => inScope(session.cwd, session.filePath)
  })
  return sessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, args.limit)
}

/** Pure membership enumeration; pruning and ranking remain execution decisions. */
async function walkInventory(
  args: Pick<ScopeScanArgs, 'discoveries' | 'options'>,
  scopePaths: readonly string[]
): Promise<{ candidates: SessionFileCandidate[]; seenPaths: Set<string> }> {
  const all: SessionFileCandidate[] = []
  const seenPaths = new Set<string>()
  let index = 0
  for (const discovery of args.discoveries) {
    if (!scopeWalksAgentFiles(discovery.agent, scopePaths)) {
      continue
    }
    const files: FileWithMtime[] = []
    for (const collection of [discovery.files, discovery.scopeFiles ?? []]) {
      for (const file of collection) {
        await yieldScanInventory(index++, args.options.signal)
        if (!seenPaths.has(file.path)) {
          seenPaths.add(file.path)
          files.push(file)
        }
      }
    }
    for (const candidate of discoveryFileCandidates(discovery, files, args.options)) {
      all.push(candidate)
    }
  }
  return { candidates: dropCodexHardlinkAliases(all), seenPaths }
}

async function walkCandidates(
  args: ScopeScanArgs,
  scopePaths: readonly string[]
): Promise<SessionFileCandidate[]> {
  const { candidates, seenPaths } = await walkInventory(args, scopePaths)
  pruneSessionScopeCwds(seenPaths)
  const workload = aiVaultScanWorkload(args.options.signal)
  const remaining: SessionFileCandidate[] = []
  for (const [index, candidate] of candidates.entries()) {
    await yieldScanInventory(index, args.options.signal)
    if (args.alreadyParsedFilePaths.has(candidate.file.path)) {
      workload?.settle(candidate, 'walk', false)
    } else {
      remaining.push(candidate)
    }
  }
  return prioritizeAntigravityTranscriptCandidates(
    remaining,
    (candidate) => candidate.agent === 'antigravity'
  )
}

export async function prepareScopeScan(
  args: Pick<ScopeScanArgs, 'discoveries' | 'options' | 'limit'>
): Promise<CwdBucketInventory[]> {
  const scopePaths = args.options.scopePaths ?? []
  if (scopePaths.length === 0) {
    return []
  }
  const workload = aiVaultScanWorkload(args.options.signal)
  // H is temporary: walk-only keys settle directly, without a second retained registry.
  if (workload) {
    const { candidates } = await walkInventory(args, scopePaths)
    for (const [index, candidate] of candidates.entries()) {
      await yieldScanInventory(index, args.options.signal)
      workload.register(candidate, 'walk')
    }
  }
  const inventories: CwdBucketInventory[] = []
  let issueLimit = SCAN_ISSUE_LIMIT
  let index = 0
  for (const source of Object.values(AI_VAULT_SCOPE_CWD_SOURCES)) {
    if (source.kind !== 'bucket') {
      continue
    }
    const inventory = await inventoryCwdBucketFiles(
      source.layout,
      {
        rootDirs: args.discoveries
          .filter((discovery) => discovery.agent === source.layout.agent)
          .map((discovery) => discovery.rootDir),
        scopePaths,
        limit: args.limit,
        signal: args.options.signal
      },
      issueLimit
    )
    issueLimit -= inventory.issues.length
    inventories.push(inventory)
    if (workload) {
      for (const paths of inventory.directories) {
        for (const path of paths) {
          await yieldScanInventory(index++, args.options.signal)
          workload.registerPath(source.layout.agent, path, 'bucket')
        }
      }
    }
  }
  return inventories
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
