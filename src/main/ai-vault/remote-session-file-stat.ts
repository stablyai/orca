import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function statRemoteSessionFile(
  provider: IFilesystemProvider,
  path: string,
  agent: AiVaultAgent,
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[],
  options?: { missingIsExpected?: boolean }
): Promise<FileWithMtime | null> {
  try {
    const stat = await provider.stat(path)
    const mtimeMs = remoteSessionMtimeMs(stat)
    return {
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString(),
      sizeBytes: stat.size,
      ...(typeof stat.dev === 'number' ? { dev: stat.dev } : {}),
      ...(typeof stat.ino === 'number' ? { ino: stat.ino } : {}),
      ...(typeof stat.nlink === 'number' ? { nlink: stat.nlink } : {})
    }
  } catch (error) {
    if (!options?.missingIsExpected || !isMissingRemoteSessionPathError(error)) {
      issues.push({ executionHostId, agent, path, message: errorMessage(error) })
    }
    return null
  }
}

export function isMissingRemoteSessionPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }
  // Relay/provider boundaries can preserve only the underlying Node error text.
  return /(?:^|[\s:])(ENOENT|ENOTDIR)(?=[\s:]|$)/.test(errorMessage(error))
}

function remoteSessionMtimeMs(stat: FileStat): number {
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) {
    return stat.mtimeMs
  }
  return stat.mtime > 10_000_000_000 ? stat.mtime : stat.mtime * 1000
}
