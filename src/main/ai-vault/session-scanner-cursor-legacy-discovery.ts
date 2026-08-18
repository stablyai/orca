import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedRealpath } from '../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  cursorBucketForCwd,
  cursorLegacySlug,
  cursorScopeCwdCandidates,
  cursorSessionActivityMtimeMs
} from './session-scanner-cursor-paths'
import { discoverFiles, type SessionDiscoveryBudget } from './session-scanner-discovery'
import type {
  AiVaultScanOptions,
  CursorCwdEvidence,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'

const CURSOR_LEGACY_MAX_ENTRIES_EXAMINED = 8_192
const CURSOR_LEGACY_MAX_FILES_STAT = 2_000
const CURSOR_SCOPE_PATH_LIMIT = 64

type CursorLegacyScanCounters = { scopeRealpath: number }

export async function discoverCursorLegacy(args: {
  roots: {
    projectsDir: string
    storageContextKey: string
    targetPlatform: NodeJS.Platform
  }
  options: AiVaultScanOptions
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const evidenceByPath = new Map<string, CursorCwdEvidence>()
  const scopedBudget = cursorLegacyBudget()
  const unscopedBudget = cursorLegacyBudget()
  const counters: CursorLegacyScanCounters = { scopeRealpath: 0 }
  const scopedFiles = await discoverScopedLegacyFiles(args, evidenceByPath, scopedBudget, counters)
  const discovered = await discoverFiles({
    rootDir: args.roots.projectsDir,
    limit: args.limit,
    agent: 'cursor',
    issues: args.issues,
    extensions: ['.jsonl'],
    filePredicate: (filePath) => filePath.split(/[\\/]/).includes('agent-transcripts'),
    directoryPredicate: (name, depth) =>
      depth === 0 || (depth === 1 && name === 'agent-transcripts') || depth === 2,
    signal: args.options.signal,
    budget: unscopedBudget
  })
  if (scopedBudget.truncated || unscopedBudget.truncated) {
    args.issues.push({
      agent: 'cursor',
      kind: 'notice',
      path: args.roots.projectsDir,
      message: 'Cursor legacy discovery reached its filesystem examination budget.'
    })
  }
  return {
    agent: 'cursor',
    rootDir: args.roots.projectsDir,
    files: dedupeCursorLegacyFiles([...scopedFiles, ...discovered.files]),
    cursorLayout: 'legacy',
    cursorStorageContextKey: args.roots.storageContextKey,
    cursorCwdEvidenceByPath: evidenceByPath,
    cursorLegacyDiscoveryCounters: {
      directoryReaddir: scopedBudget.directoriesRead + unscopedBudget.directoriesRead,
      direntsRead: scopedBudget.direntsRead + unscopedBudget.direntsRead,
      fileStat:
        CURSOR_LEGACY_MAX_FILES_STAT * 2 -
        scopedBudget.filesRemaining -
        unscopedBudget.filesRemaining,
      scopeRealpath: counters.scopeRealpath
    },
    cursorLegacyDiscoveryTruncated: {
      entries: scopedBudget.entriesTruncated || unscopedBudget.entriesTruncated,
      files: scopedBudget.filesTruncated || unscopedBudget.filesTruncated
    }
  }
}

async function discoverScopedLegacyFiles(
  args: Parameters<typeof discoverCursorLegacy>[0],
  evidenceByPath: Map<string, CursorCwdEvidence>,
  budget: SessionDiscoveryBudget,
  counters: CursorLegacyScanCounters
): Promise<FileWithMtime[]> {
  const files: FileWithMtime[] = []
  for (const cwd of await localScopeCandidates(args, counters)) {
    const slug = cursorLegacySlug(cwd)
    if (!slug) {
      continue
    }
    const discovery = await discoverFiles({
      rootDir: join(args.roots.projectsDir, slug, 'agent-transcripts'),
      limit: Math.max(args.limit, CURSOR_LEGACY_MAX_FILES_STAT),
      agent: 'cursor',
      issues: args.issues,
      extensions: ['.jsonl'],
      signal: args.options.signal,
      budget
    })
    for (const file of discovery.files) {
      evidenceByPath.set(file.path, {
        kind: 'legacy-scope-only',
        cwd: null,
        bucket: cursorBucketForCwd(cwd, args.roots.targetPlatform)
      })
      files.push(file)
    }
  }
  return files
}

async function localScopeCandidates(
  args: Parameters<typeof discoverCursorLegacy>[0],
  counters: CursorLegacyScanCounters
): Promise<string[]> {
  const candidates = new Set<string>()
  const scopePaths = relevantScopePaths(args)
  if (scopePaths.length > CURSOR_SCOPE_PATH_LIMIT) {
    args.issues.push({
      agent: 'cursor',
      kind: 'notice',
      path: args.roots.projectsDir,
      message: `Cursor legacy discovery reached its ${CURSOR_SCOPE_PATH_LIMIT}-path scope limit.`
    })
  }
  for (const scopePath of scopePaths.slice(0, CURSOR_SCOPE_PATH_LIMIT)) {
    addScopeCandidates(candidates, scopePath, args)
    try {
      counters.scopeRealpath += 1
      addScopeCandidates(
        candidates,
        await wslGatedRealpath(scopePath, 'scan', args.options.signal),
        args
      )
    } catch {
      throwIfAiVaultScanCancelled(args.options.signal)
    }
  }
  return [...candidates]
}

function relevantScopePaths(args: Parameters<typeof discoverCursorLegacy>[0]): string[] {
  const paths = new Set<string>()
  for (const rawPath of args.options.scopePaths ?? []) {
    const scopePath = rawPath.trim()
    if (
      scopePath &&
      cursorScopeCwdCandidates({
        scopePath,
        platform: args.roots.targetPlatform,
        storageContextKey: args.roots.storageContextKey
      }).length > 0
    ) {
      paths.add(scopePath)
    }
  }
  return [...paths]
}

function addScopeCandidates(
  candidates: Set<string>,
  scopePath: string,
  args: Parameters<typeof discoverCursorLegacy>[0]
): void {
  for (const cwd of cursorScopeCwdCandidates({
    scopePath,
    platform: args.roots.targetPlatform,
    storageContextKey: args.roots.storageContextKey
  })) {
    candidates.add(cwd)
  }
}

function cursorLegacyBudget(): SessionDiscoveryBudget {
  return {
    entriesRemaining: CURSOR_LEGACY_MAX_ENTRIES_EXAMINED,
    filesRemaining: CURSOR_LEGACY_MAX_FILES_STAT,
    truncated: false,
    entriesTruncated: false,
    filesTruncated: false,
    directoriesRead: 0,
    direntsRead: 0
  }
}

function dedupeCursorLegacyFiles(files: readonly FileWithMtime[]): FileWithMtime[] {
  const byPath = new Map(files.map((file) => [file.path, file]))
  return [...byPath.values()].sort(
    (left, right) => cursorSessionActivityMtimeMs(right) - cursorSessionActivityMtimeMs(left)
  )
}
