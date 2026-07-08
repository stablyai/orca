import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function statRemoteFile(
  provider: IFilesystemProvider,
  path: string,
  agent: AiVaultAgent,
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime | null> {
  try {
    const stat = await provider.stat(path)
    const mtimeMs = remoteStatMtimeMs(stat)
    return {
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString(),
      sizeBytes: Number.isFinite(stat.size) ? stat.size : undefined
    }
  } catch (err) {
    issues.push({ executionHostId, agent, path, message: errorMessage(err) })
    return null
  }
}

function remoteStatMtimeMs(stat: FileStat): number {
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) {
    return stat.mtimeMs
  }
  return stat.mtime > 10_000_000_000 ? stat.mtime : stat.mtime * 1000
}
