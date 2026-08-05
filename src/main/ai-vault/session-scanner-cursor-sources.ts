import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorBucketForCwd,
  cursorLegacySlug,
  cursorSessionActivityMtimeMs,
  cursorScopeCwdCandidates,
  cursorStorageContextKey,
  isSafeCursorSessionBasename,
  resolveCursorLocalRoots
} from './session-scanner-cursor-paths'
import {
  cursorLocalFileMetadata,
  discoverLocalCursorSidecars,
  isMissingCursorPathError,
  localCursorRootRealPath,
  validateLocalCursorSidecars
} from './session-scanner-cursor-local-files'
import { discoverFiles } from './session-scanner-discovery'
import type {
  AiVaultScanOptions,
  CursorCwdEvidence,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

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
  const expectedRootRealPath = await localCursorRootRealPath(args.roots.chatsDir, args.issues)
  if (!expectedRootRealPath) {
    return {
      agent: 'cursor',
      rootDir: args.roots.chatsDir,
      files: [],
      cursorLayout: 'sidecar',
      cursorStorageContextKey: args.roots.storageContextKey
    }
  }
  const discovered = await discoverLocalCursorSidecars(args.roots.chatsDir, args.issues)
  const evidenceByPath = new Map<string, CursorCwdEvidence>()
  const scopedFiles = await discoverScopedSidecars(args, evidenceByPath)
  const files = await validateLocalCursorSidecars(
    dedupeFiles([...scopedFiles, ...discovered]),
    args.issues
  )
  const rankedFiles = dedupeFiles(files)
  const scopedPaths = new Set(evidenceByPath.keys())
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
    cursorCwdEvidenceByPath: evidenceByPath,
    cursorExpectedRootRealPath: expectedRootRealPath
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

async function discoverScopedSidecars(
  args: {
    roots: CursorRootPair
    options: AiVaultScanOptions
    limit: number
    issues: AiVaultScanIssue[]
  },
  evidenceByPath: Map<string, CursorCwdEvidence>
): Promise<FileWithMtime[]> {
  const files: FileWithMtime[] = []
  for (const cwd of await localScopeCandidates(args)) {
    const bucket = cursorBucketForCwd(cwd, args.roots.targetPlatform)
    const bucketDir = join(args.roots.chatsDir, bucket)
    let entries
    try {
      const bucketStat = await lstat(bucketDir)
      if (!bucketStat.isDirectory() || bucketStat.isSymbolicLink()) {
        continue
      }
      entries = await readdir(bucketDir, { withFileTypes: true })
    } catch (error) {
      if (!isMissingCursorPathError(error)) {
        args.issues.push({ agent: 'cursor', path: bucketDir, message: errorMessage(error) })
      }
      continue
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !isSafeCursorSessionBasename(entry.name)
      ) {
        continue
      }
      const metaPath = join(bucketDir, entry.name, 'meta.json')
      const file = await cursorLocalFileMetadata(metaPath)
      if (file) {
        evidenceByPath.set(metaPath, { kind: 'scope-bucket', cwd, bucket })
        files.push(file)
      }
    }
  }
  return files
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

function dedupeFiles(files: readonly FileWithMtime[]): FileWithMtime[] {
  const byPath = new Map<string, FileWithMtime>()
  for (const file of files) {
    byPath.set(file.path, file)
  }
  return [...byPath.values()].sort(
    (left, right) => cursorSessionActivityMtimeMs(right) - cursorSessionActivityMtimeMs(left)
  )
}
