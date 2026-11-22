import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { aiVaultScanLimit } from '../../../../shared/ai-vault/scanning/ai-vault-session-depth'
import { createAiVaultScopeCwdMatcher } from '../../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { forEachWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { extractString } from '../../../../shared/text/trimmed-string'
import { readLocalFileBounded } from '../../../filesystem/local-file-io/local-regular-file-read'
import { discoverFiles } from '../../discovery/session-scanner-discovery'
import { parseJsonObject } from '../../parsing/session-json-object'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  attachAiVaultScopeCwdAliases,
  resolveAiVaultScopeRealPaths
} from '../../scope/session-scope-real-paths'
import type { FileWithMtime } from '../../session-scanner-types'

const METADATA_BYTES = 64 * 1024
const LOCAL_METADATA_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

export async function scanCursorAcpMetadata(
  rootDir: string,
  args?: AiVaultListArgs,
  signal?: AbortSignal
): Promise<AiVaultListResult> {
  throwIfAiVaultScanCancelled(signal)
  // This source is a desktop-only overlay, not part of search or the deletable Cursor CLI roots.
  const issues: AiVaultScanIssue[] = []
  const sessions: AiVaultSession[] = []
  const scannedAt = new Date().toISOString()
  const scope = await resolveAiVaultScopeRealPaths(args?.scopePaths ?? [])
  const inScope = scope.scanScopePaths.length
    ? createAiVaultScopeCwdMatcher(scope.scanScopePaths)
    : null
  const scopedOnly = args?.scopeOnly === true && inScope !== null
  const limit = aiVaultScanLimit(args)
  const canonicalRoot = await canonicalMetadataRoot(rootDir)
  if (!canonicalRoot) {
    return { sessions, issues, scannedAt }
  }

  const discovery = await discoverFiles({
    rootDir: canonicalRoot,
    limit: limit * 2,
    agent: 'cursor',
    issues,
    extensions: ['.json'],
    directoryPredicate: (_name, depth) => depth === 0,
    filePredicate: (filePath) => cursorAcpSessionId(canonicalRoot, filePath) !== null,
    keepScopeFiles: inScope !== null,
    signal
  })
  const files = [...discovery.files, ...(discovery.scopeFiles ?? [])]
  const recentPaths = new Set(discovery.files.map((file) => file.path))
  await forEachWithConcurrency(files, 4, async (file) => {
    const session = await readCursorAcpMetadata(canonicalRoot, file, signal)
    if (
      session &&
      (inScope?.(session.cwd, session.filePath) || (!scopedOnly && recentPaths.has(file.path)))
    ) {
      sessions.push(session)
    }
  })
  throwIfAiVaultScanCancelled(signal)
  return attachAiVaultScopeCwdAliases({ sessions, issues, scannedAt }, scope)
}

async function canonicalMetadataRoot(rootDir: string): Promise<string | null> {
  try {
    return (await lstat(rootDir)).isDirectory() ? await realpath(rootDir) : null
  } catch {
    return null
  }
}

function cursorAcpSessionId(rootDir: string, filePath: string): string | null {
  const [sessionId, name, extra] = relative(rootDir, filePath).split(sep)
  return sessionId &&
    sessionId !== '..' &&
    sessionId.length <= 512 &&
    name === 'meta.json' &&
    extra === undefined
    ? sessionId
    : null
}

async function readCursorAcpMetadata(
  rootDir: string,
  file: FileWithMtime,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  throwIfAiVaultScanCancelled(signal)
  const sessionId = cursorAcpSessionId(rootDir, file.path)
  if (!sessionId || (file.sizeBytes ?? 0) > METADATA_BYTES) {
    return null
  }
  try {
    const before = await lstat(file.path)
    if (
      !before.isFile() ||
      before.size > METADATA_BYTES ||
      (await realpath(file.path)) !== file.path
    ) {
      return null
    }
    const handle = await open(file.path, LOCAL_METADATA_READ_FLAGS)
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
        return null
      }
      const bytes = await readLocalFileBounded(handle, METADATA_BYTES, current.size)
      return cursorAcpMetadataRow(sessionId, file.modifiedAt, bytes.toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function cursorAcpMetadataRow(
  sessionId: string,
  modifiedAt: string,
  content: string
): AiVaultSession | null {
  const metadata = parseJsonObject(content)
  const cwd = extractString(metadata?.cwd)
  if (!cwd || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes('\0')) {
    return null
  }
  const filePath = `cursor-acp#${sessionId}`
  return {
    id: `${LOCAL_EXECUTION_HOST_ID}:cursor:${sessionId}:${filePath}`,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    agent: 'cursor',
    sessionId,
    historySource: 'cursor-acp-metadata',
    title: extractString(metadata?.title)?.slice(0, 512) ?? 'Cursor Chat',
    cwd,
    branch: null,
    model: null,
    filePath,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}
