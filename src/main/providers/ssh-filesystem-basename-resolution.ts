import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { buildExcludePathPrefixes } from '../../shared/quick-open-filter'
import { resolveUniqueQuickOpenBasenameFromPaths } from '../../shared/quick-open-unique-basename'

type ListRemoteFiles = (
  rootPath: string,
  options?: { excludePaths?: string[] }
) => Promise<string[]>

export async function resolveSshUniqueFileByBasename(
  mux: SshChannelMultiplexer,
  listFiles: ListRemoteFiles,
  rootPath: string,
  basename: string,
  options?: { excludePaths?: string[] }
): Promise<string | null> {
  const params: Record<string, unknown> = { rootPath, basename }
  if (options?.excludePaths && options.excludePaths.length > 0) {
    params.excludePaths = options.excludePaths
  }
  try {
    return (await mux.request('fs.resolveUniqueFileByBasename', params)) as string | null
  } catch (error) {
    if (!isMethodNotFoundError(error)) {
      throw error
    }
    // Why: older relays do not know the targeted basename RPC. Preserve the
    // bug fix across that compatibility window, then filter locally.
    const files = await listFiles(rootPath, options)
    return resolveUniqueQuickOpenBasenameFromPaths(
      files,
      basename,
      buildExcludePathPrefixes(rootPath, options?.excludePaths)
    )
  }
}
