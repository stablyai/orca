import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorContextPathForHash,
  cursorSessionActivityMtimeMs,
  cursorScopeCwdCandidates,
  cursorStorageContextKey,
  resolveCursorLocalRoots
} from './session-scanner-cursor-paths'
import { discoverLocalCursorSidecarsBounded } from './session-scanner-cursor-local-files'
import { discoverCursorLegacy } from './session-scanner-cursor-legacy-discovery'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'
import {
  createAiVaultScanCancelledError,
  throwIfAiVaultScanCancelled
} from './ai-vault-scan-cancellation'
import { errorMessage } from './session-scanner-values'
import { wslGatedRealpath } from '../native-chat/wsl-transcript-fs-access'

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
  issues: AiVaultScanIssue[],
  behavior: { reportMissingSidecarRoot?: boolean } = {}
): Promise<SessionFileDiscovery>[] {
  return cursorRootPairs(options, wslHomeDirs).flatMap((roots) => [
    discoverCursorSidecars({
      roots,
      options,
      limit,
      issues,
      reportMissingRoot: behavior.reportMissingSidecarRoot === true
    }),
    discoverCursorLegacy({ roots, options, limit, issues })
  ])
}

async function discoverCursorSidecars(args: {
  roots: CursorRootPair
  options: AiVaultScanOptions
  limit: number
  issues: AiVaultScanIssue[]
  reportMissingRoot: boolean
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
          targetPlatform: args.roots.targetPlatform,
          signal: args.options.signal
        })
    })
  } catch (error) {
    throwIfAiVaultScanCancelled(args.options.signal)
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
    if (args.reportMissingRoot) {
      args.issues.push({
        agent: 'cursor',
        path: args.roots.chatsDir,
        message: 'Cursor sidecar root could not be resolved.'
      })
    }
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
  signal?: AbortSignal
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
    const resolved = await (
      args.realpathPath ?? ((path) => wslGatedRealpath(path, 'scan', args.signal))
    )(args.scopePath)
    for (const candidate of cursorScopeCwdCandidates({
      scopePath: resolved,
      storageContextKey: args.storageContextKey,
      platform: args.targetPlatform
    })) {
      candidates.add(candidate)
    }
  } catch {
    if (args.signal?.aborted) {
      throw new Error('cursor_sidecar_scan_cancelled')
    }
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
