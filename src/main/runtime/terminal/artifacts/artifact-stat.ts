import { open } from 'node:fs/promises'
import { assertLocalTerminalArtifactPathStillCanonical } from './local-artifact-read'
import {
  LOCAL_READ_OPEN_FLAGS,
  NOT_A_REGULAR_FILE_MESSAGE
} from '../../../ipc/filesystem/local-regular-file-read'
import { localTerminalArtifactContentDigest } from './artifact-integrity'
import type { RuntimeFileStatLike } from './file-grants'

/** Stat and content digest come from one handle to retain the existing swap protection. */
export async function statLocalTerminalArtifact(absolutePath: string): Promise<{
  stats: RuntimeFileStatLike & { isDirectory: () => boolean }
  contentDigest: string | null
}> {
  await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
  const handle = await open(absolutePath, LOCAL_READ_OPEN_FLAGS)
  try {
    const stats = await handle.stat()
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
    }
    const contentDigest = stats.isDirectory()
      ? null
      : await localTerminalArtifactContentDigest(handle, stats.size)
    return { stats, contentDigest }
  } finally {
    await handle.close()
  }
}
