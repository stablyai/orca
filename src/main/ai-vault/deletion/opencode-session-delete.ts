import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, posix } from 'node:path'
import type {
  AiVaultDatabaseRowAgent,
  AiVaultDeleteSessionResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { managedOpenCodeAccountDataDirs } from '../../opencode/accounts/opencode-managed-account-data-dirs'
import {
  resolveOpenCodeDataDirectory,
  resolveOpenCodeDatabasePath
} from '../../opencode/accounts/opencode-data-directory'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import { deleteOpenCodeSessionWithCli } from './session-delete-command'

export type OpenCodeHostSessionDeleteArgs = {
  agent: AiVaultDatabaseRowAgent
  filePath: string
  sessionId?: string
  executionHostId?: ExecutionHostId
  wslHomeDirs: readonly string[]
}

/** Delete one OpenCode row through `opencode session delete`, pointing it at this row's store. */
export async function deleteHostOpenCodeSession(
  args: OpenCodeHostSessionDeleteArgs
): Promise<AiVaultDeleteSessionResult> {
  const { agent } = args
  if (normalizeExecutionHostId(args.executionHostId) !== LOCAL_EXECUTION_HOST_ID) {
    return { outcome: 'rejected', agent, reason: 'non-local-host' }
  }
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
  const targetRow = resolveOpenCodeSessionRow(filePath, args.sessionId)
  if (!targetRow) {
    return { outcome: 'rejected', agent, reason: 'invalid-path' }
  }

  const target = await resolveOpenCodeDeleteTarget(targetRow.dbPath, args.wslHomeDirs)
  if (!target) {
    return { outcome: 'rejected', agent, reason: 'path-outside-known-roots' }
  }
  if ('error' in target) {
    return { outcome: 'failed', agent, error: target.error }
  }
  // A store removed since the scan is already deleted; the row only needs its caches cleared.
  if (target.missing) {
    return { outcome: 'deleted' }
  }

  const result = await deleteOpenCodeSessionWithCli({
    dbPath: target.dbPath,
    sessionId: targetRow.sessionId,
    ...(target.wslDistro ? { wslDistro: target.wslDistro } : {})
  })
  if (result.outcome === 'deleted' || result.outcome === 'not-found') {
    return { outcome: 'deleted' }
  }
  console.warn('[ai-vault] OpenCode session delete failed:', result.error)
  return { outcome: 'failed', agent, error: result.error }
}

// A scanned row stores the database path and the session id separately; older clients used db#id.
export function resolveOpenCodeSessionRow(
  filePath: string,
  sessionId: string | undefined
): { dbPath: string; sessionId: string } | null {
  const trimmed = filePath.trim()
  if (!trimmed) {
    return null
  }
  const requestedSessionId = sessionId?.trim()
  if (!requestedSessionId) {
    return splitDbSessionPath(trimmed)
  }
  const parsed = splitDbSessionPath(trimmed)
  if (parsed && /^ses/i.test(parsed.sessionId)) {
    return parsed.sessionId === requestedSessionId ? parsed : null
  }
  // The scanned row stores the database path alone; a '#' may be part of a directory name.
  return { dbPath: trimmed, sessionId: requestedSessionId }
}

function splitDbSessionPath(candidatePath: string): { dbPath: string; sessionId: string } | null {
  const separatorIndex = candidatePath.lastIndexOf('#')
  if (separatorIndex <= 0 || separatorIndex === candidatePath.length - 1) {
    return null
  }
  return {
    dbPath: candidatePath.slice(0, separatorIndex),
    sessionId: candidatePath.slice(separatorIndex + 1)
  }
}

type OpenCodeDeleteTarget =
  | { dbPath: string; wslDistro?: string; missing?: false }
  | { missing: true }
  | { error: string }

async function resolveOpenCodeDeleteTarget(
  dbPath: string,
  wslHomeDirs: readonly string[]
): Promise<OpenCodeDeleteTarget | null> {
  const wsl = parseWslUncPath(dbPath)
  if (wsl) {
    const roots = wslHomeDirs.flatMap((homeDir) => {
      const parsed = parseWslUncPath(homeDir)
      return parsed && parsed.distro.toLowerCase() === wsl.distro.toLowerCase()
        ? [posix.join(parsed.linuxPath, '.local', 'share', 'opencode')]
        : []
    })
    if (!roots.some((root) => isPathInsideOrEqual(root, wsl.linuxPath))) {
      return null
    }
    const existence = await wslDatabaseExistence(dbPath)
    if (existence !== 'exists') {
      return existence === 'missing' ? { missing: true } : existence
    }
    return { dbPath: wsl.linuxPath, wslDistro: wsl.distro }
  }

  const roots = nativeDatabaseRoots()
  if (!roots.some((root) => isPathInsideOrEqual(root, dbPath))) {
    return null
  }
  const containment = await resolveNativeDatabaseContainment(dbPath, roots)
  if (containment === 'outside') {
    return null
  }
  return containment === 'missing' ? { missing: true } : { dbPath }
}

function nativeDatabaseRoots(): string[] {
  const override = resolveOpenCodeDatabasePath()
  const roots = new Set<string>([
    resolveOpenCodeDataDirectory(),
    ...(override ? [dirname(override)] : []),
    ...managedOpenCodeAccountDataDirs()
  ])
  return [...roots].filter((root) => isAbsolute(root))
}

async function resolveNativeDatabaseContainment(
  dbPath: string,
  roots: readonly string[]
): Promise<'inside' | 'outside' | 'missing'> {
  let realDbPath: string
  try {
    realDbPath = await realpath(dbPath)
  } catch (error) {
    return isENOENT(error) ? 'missing' : 'outside'
  }
  if (!(await stat(realDbPath).catch(() => null))?.isFile()) {
    return 'outside'
  }
  // A symlinked parent could escape the textual check; require the real path inside a real root.
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
  return realRoots.some((root) => root && isPathInsideOrEqual(root, realDbPath))
    ? 'inside'
    : 'outside'
}

async function wslDatabaseExistence(
  dbPath: string
): Promise<'exists' | 'missing' | { error: string }> {
  try {
    return (await stat(dbPath)).isFile()
      ? 'exists'
      : { error: 'OpenCode database path is not a file.' }
  } catch (error) {
    return isENOENT(error)
      ? 'missing'
      : { error: error instanceof Error ? error.message : String(error) }
  }
}
