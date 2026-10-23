import { constants } from 'node:fs/promises'
import { openLocalTerminalArtifactPath } from './local-artifact-read'
import { localTerminalArtifactContentDigest } from './artifact-integrity'
import type { RuntimeFileStatLike } from './file-grants'

/** Stat and content digest come from one handle to retain the existing swap protection. */
export async function statLocalTerminalArtifact(absolutePath: string): Promise<{
  stats: RuntimeFileStatLike & { isDirectory: () => boolean; isFile: () => boolean }
  contentDigest: string | null
}> {
  const handle = await openLocalTerminalArtifactPath(absolutePath, constants.O_RDONLY)
  try {
    const stats = await handle.stat()
    const contentDigest = stats.isFile()
      ? await localTerminalArtifactContentDigest(handle, stats.size)
      : null
    return { stats, contentDigest }
  } finally {
    await handle.close()
  }
}
