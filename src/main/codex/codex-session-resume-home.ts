import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'

// Why: only Codex's dated rollout layout may establish account-home provenance; nested/misplaced JSONL must not select credentials.
const ROLLOUT_RELATIVE_PATH = /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl(?:\.zst)?$/

function isCodexRolloutInsideSessionsRoot(sessionsRoot: string, filePath: string): boolean {
  const relativePath = relativePathInsideRoot(sessionsRoot, filePath)
  return Boolean(relativePath && ROLLOUT_RELATIVE_PATH.test(relativePath.replace(/\\/g, '/')))
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function resolveExistingRolloutPath(
  transcriptPath: string,
  fileIsRegular: (filePath: string) => boolean
): string | null {
  const plainPath = transcriptPath.endsWith('.jsonl.zst')
    ? transcriptPath.slice(0, -'.zst'.length)
    : transcriptPath.endsWith('.jsonl')
      ? transcriptPath
      : null
  if (!plainPath) {
    return fileIsRegular(transcriptPath) ? transcriptPath : null
  }
  if (fileIsRegular(plainPath)) {
    return plainPath
  }
  const compressedPath = `${plainPath}.zst`
  return fileIsRegular(compressedPath) ? compressedPath : null
}

function resolveTrustedCodexSessionResume(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): { homePath: string; transcriptPath: string } | null {
  const persistedPath = args.transcriptPath?.trim()
  if (!persistedPath) {
    return null
  }

  for (const homePath of args.trustedCodexHomes) {
    const sessionsRoot = join(homePath, 'sessions')
    if (!isCodexRolloutInsideSessionsRoot(sessionsRoot, persistedPath)) {
      continue
    }
    const transcriptPath = resolveExistingRolloutPath(
      persistedPath,
      args.fileIsRegular ?? isRegularFile
    )
    if (transcriptPath) {
      return { homePath, transcriptPath }
    }
  }
  return null
}

export function resolveTrustedCodexSessionResumeHome(args: {
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
}): string | null {
  return resolveTrustedCodexSessionResume(args)?.homePath ?? null
}

export async function findTrustedCodexSessionResume(args: {
  sessionId: string
  transcriptPath: string | undefined
  trustedCodexHomes: readonly string[]
  fileIsRegular?: (filePath: string) => boolean
  listSessionFiles?: (sessionsRoot: string) => AsyncIterable<string>
}): Promise<{ homePath: string; transcriptPath: string } | null> {
  const directSession = resolveTrustedCodexSessionResume(args)
  if (directSession) {
    return directSession
  }
  if (args.transcriptPath?.trim()) {
    // Why: stale/rejected provenance must not select a same-id rollout under different account credentials; scanning is legacy-only.
    return null
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.sessionId)) {
    return null
  }

  const listSessionFiles =
    args.listSessionFiles ??
    ((sessionsRoot: string) =>
      listCodexSessionRolloutFilesIncrementally(sessionsRoot, { batchSize: 64, yieldMs: 0 }))
  const expectedSuffix = `-${args.sessionId}.jsonl`.toLowerCase()
  const seenHomes = new Set<string>()
  for (const homePath of args.trustedCodexHomes) {
    const comparisonHome = normalizeRuntimePathForComparison(homePath)
    if (seenHomes.has(comparisonHome)) {
      continue
    }
    seenHomes.add(comparisonHome)
    const sessionsRoot = join(homePath, 'sessions')
    if (!args.listSessionFiles && !existsSync(sessionsRoot)) {
      continue
    }
    for await (const filePath of listSessionFiles(sessionsRoot)) {
      const plainFilePath = filePath.endsWith('.jsonl.zst')
        ? filePath.slice(0, -'.zst'.length)
        : filePath
      // Why: the directory entry already proves the compressed file exists; only probe its preferred plain sibling.
      const preferredFilePath =
        plainFilePath !== filePath && (args.fileIsRegular ?? isRegularFile)(plainFilePath)
          ? plainFilePath
          : filePath
      const plainFileName = getRuntimePathBasename(preferredFilePath)
        .toLowerCase()
        .replace(/\.zst$/, '')
      if (
        isCodexRolloutInsideSessionsRoot(sessionsRoot, preferredFilePath) &&
        plainFileName.endsWith(expectedSuffix)
      ) {
        return { homePath, transcriptPath: preferredFilePath }
      }
    }
  }
  return null
}
