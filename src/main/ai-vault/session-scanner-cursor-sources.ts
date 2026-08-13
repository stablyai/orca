import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorBucketForCwd,
  cursorContextPathForHash,
  cursorLegacySlug,
  cursorSessionActivityMtimeMs,
  cursorScopeCwdCandidates,
  cursorStorageContextKey,
  resolveCursorLocalRoots
} from './session-scanner-cursor-paths'
import { discoverLocalCursorSidecarsBounded } from './session-scanner-cursor-local-files'
import { discoverFiles } from './session-scanner-discovery'
import type {
  AiVaultScanOptions,
  CursorCwdEvidence,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import { errorMessage } from './session-scanner-values'

// Matches the shared owning-host scope cap; conversion work stays bounded too.
const CURSOR_SCOPE_PATH_LIMIT = 64

type CursorRootPair = {
  chatsDir: string
  projectsDir: string
  storageContextKey: string
  targetPlatform: NodeJS.Platform
}

export function cursorRootPairs(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): CursorRootPair[] {
  const defaults = resolveCursorLocalRoots()
  const nativePlatform = options.platform ?? process.platform
  return [
    {
      chatsDir: options.cursorChatsDir ?? defaults.chatsDir,
      projectsDir: options.cursorProjectsDir ?? defaults.projectsDir,
      storageContextKey: 'native',
      targetPlatform: nativePlatform
    },
    ...wslHomeDirs.map((homeDir) => ({
      chatsDir: join(homeDir, '.cursor', 'chats'),
      projectsDir: join(homeDir, '.cursor', 'projects'),
      storageContextKey: cursorStorageContextKey(homeDir),
      targetPlatform: 'linux' as const
    }))
  ]
}

export function cursorDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return cursorRootPairs(options, wslHomeDirs).flatMap((roots) => [
    discoverCursorSidecars({ roots, options, limit, issues }),
    discoverCursorLegacy({ roots, options, limit, issues })
  ])
}

async function discoverCursorSidecars(args: {
  roots: CursorRootPair
  options: AiVaultScanOptions
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const startedAt = Date.now()
  const scopePaths = localSidecarScopePaths(args)
  let discovery
  try {
    discovery = await discoverLocalCursorSidecarsBounded({
      chatsDir: args.roots.chatsDir,
      scopePaths,
      issues: args.issues,
      signal: args.options.signal,
      pathPlatform: args.roots.targetPlatform,
      resolveScopePaths: (scopePath) =>
        resolveLocalSidecarScopePaths({
          scopePath,
          storageContextKey: args.roots.storageContextKey,
          targetPlatform: args.roots.targetPlatform
        })
    })
  } catch (error) {
    if ((error as Error).message === 'cursor_sidecar_scan_cancelled') {
      throw createAiVaultScanCancelledError()
    }
    args.issues.push({
      agent: 'cursor',
      path: args.roots.chatsDir,
      message: errorMessage(error)
    })
    return {
      agent: 'cursor',
      rootDir: args.roots.chatsDir,
      files: [],
      cursorLayout: 'sidecar',
      cursorStorageContextKey: args.roots.storageContextKey,
      cursorTargetPlatform: args.roots.targetPlatform
    }
  }

  const counters = {
    ...discovery.counters,
    elapsedMs: Math.max(0, Date.now() - startedAt)
  }
  if (!discovery.rootRealPath) {
    return {
      agent: 'cursor',
      rootDir: args.roots.chatsDir,
      files: [],
      cursorLayout: 'sidecar',
      cursorStorageContextKey: args.roots.storageContextKey,
      cursorTargetPlatform: args.roots.targetPlatform,
      cursorDiscoveryCounters: counters,
      cursorDiscoveryTruncated: discovery.truncated
    }
  }

  const rankedFiles = dedupeFiles(discovery.files)
  const scopedPaths = new Set(discovery.evidenceByPath.keys())
  // Scope buckets stay outside the unscoped retention window; unscoped entries
  // still honor the per-agent discovery limit used by the rest of AI Vault.
  const retained = dedupeFiles([
    ...rankedFiles.filter((file) => scopedPaths.has(file.path)),
    ...rankedFiles.filter((file) => !scopedPaths.has(file.path)).slice(0, args.limit)
  ])
  return {
    agent: 'cursor',
    rootDir: args.roots.chatsDir,
    files: retained,
    cursorLayout: 'sidecar',
    cursorStorageContextKey: args.roots.storageContextKey,
    cursorTargetPlatform: args.roots.targetPlatform,
    cursorCwdEvidenceByPath: discovery.evidenceByPath,
    cursorExpectedRootRealPath: discovery.rootRealPath,
    cursorDiscoveryCounters: counters,
    cursorDiscoveryTruncated: discovery.truncated
  }
}

async function discoverCursorLegacy(args: {
  roots: CursorRootPair
  options: AiVaultScanOptions
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const discovered = await discoverFiles({
    rootDir: args.roots.projectsDir,
    limit: args.limit,
    agent: 'cursor',
    issues: args.issues,
    extensions: ['.jsonl'],
    filePredicate: (filePath) => filePath.split(/[\\/]/).includes('agent-transcripts')
  })
  const evidenceByPath = new Map<string, CursorCwdEvidence>()
  const scopedFiles: FileWithMtime[] = []
  for (const cwd of await localScopeCandidates(args)) {
    const slug = cursorLegacySlug(cwd)
    if (!slug) {
      continue
    }
    const scopeDiscovery = await discoverFiles({
      rootDir: join(args.roots.projectsDir, slug, 'agent-transcripts'),
      limit: Math.max(args.limit, 2000),
      agent: 'cursor',
      issues: args.issues,
      extensions: ['.jsonl']
    })
    for (const file of scopeDiscovery.files) {
      evidenceByPath.set(file.path, {
        kind: 'legacy-scope-only',
        cwd: null,
        bucket: cursorBucketForCwd(cwd, args.roots.targetPlatform)
      })
      scopedFiles.push(file)
    }
  }
  return {
    agent: 'cursor',
    rootDir: args.roots.projectsDir,
    files: dedupeFiles([...scopedFiles, ...discovered.files]),
    cursorLayout: 'legacy',
    cursorStorageContextKey: args.roots.storageContextKey,
    cursorCwdEvidenceByPath: evidenceByPath
  }
}

async function localScopeCandidates(args: {
  roots: CursorRootPair
  options: AiVaultScanOptions
}): Promise<string[]> {
  const candidates = new Set<string>()
  for (const scopePath of (args.options.scopePaths ?? []).slice(0, CURSOR_SCOPE_PATH_LIMIT)) {
    for (const cwd of cursorScopeCwdCandidates({
      scopePath,
      platform: args.roots.targetPlatform,
      storageContextKey: args.roots.storageContextKey
    })) {
      candidates.add(cwd)
    }
    try {
      const resolved = await realpath(scopePath)
      for (const cwd of cursorScopeCwdCandidates({
        scopePath: resolved,
        platform: args.roots.targetPlatform,
        storageContextKey: args.roots.storageContextKey
      })) {
        candidates.add(cwd)
      }
    } catch {
      // A scope path need not exist in every selected storage context.
    }
  }
  return [...candidates]
}

function localSidecarScopePaths(args: {
  roots: CursorRootPair
  options: AiVaultScanOptions
}): string[] {
  const paths = new Set<string>()
  for (const scopePath of args.options.scopePaths ?? []) {
    const trimmed = scopePath.trim()
    if (
      trimmed &&
      cursorContextPathForHash(trimmed, args.roots.storageContextKey, args.roots.targetPlatform)
    ) {
      paths.add(trimmed)
    }
  }
  return [...paths]
}

export async function resolveLocalSidecarScopePaths(args: {
  scopePath: string
  storageContextKey: string
  targetPlatform: NodeJS.Platform
  realpathPath?: (path: string) => Promise<string>
}): Promise<string[]> {
  const candidates = new Set(
    cursorScopeCwdCandidates({
      scopePath: args.scopePath,
      storageContextKey: args.storageContextKey,
      platform: args.targetPlatform
    })
  )
  try {
    const resolved = await (args.realpathPath ?? realpath)(args.scopePath)
    for (const candidate of cursorScopeCwdCandidates({
      scopePath: resolved,
      storageContextKey: args.storageContextKey,
      platform: args.targetPlatform
    })) {
      candidates.add(candidate)
    }
  } catch {
    // A scope path need not exist in every selected storage context.
  }
  return [...candidates]
}

function dedupeFiles(files: readonly FileWithMtime[]): FileWithMtime[] {
  const byPath = new Map<string, FileWithMtime>()
  for (const file of files) {
    byPath.set(file.path, file)
  }
  return [...byPath.values()].sort(
    (left, right) => cursorSessionActivityMtimeMs(right) - cursorSessionActivityMtimeMs(left)
  )
}
