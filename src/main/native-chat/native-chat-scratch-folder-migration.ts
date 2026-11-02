// Saved replies contain only filenames, so pre-rename visuals must move before the host serves reads.
// Conflicting files stay in a recovery subfolder governed by the chat's existing retention.

import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rmdir,
  unlink,
  utimes
} from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  isNativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

const LEGACY_ROOT_NAME = 'native-chat-visuals'
const SCOPE = 'nativeChatVisuals.migration'

type Presence = 'absent' | 'directory' | 'other'

/** What sits at `path` without following it: a link is never a place this host moves files into. */
async function presenceOf(path: string): Promise<Presence> {
  try {
    return (await lstat(path)).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
}

async function removeIfEmpty(path: string): Promise<boolean> {
  try {
    await rmdir(path)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (isDefinitiveAbsence(error)) {
      return true
    }
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return false
    }
    throw error
  }
}

// Import only original names: an alias could take another saved visual's filename.
async function mergeFolder(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue
    }
    const source = join(from, entry.name)
    try {
      await copyFile(source, join(to, entry.name), constants.COPYFILE_EXCL)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        continue
      }
      throw error
    }
    await unlink(source)
  }
  if (!(await removeIfEmpty(from))) {
    const recovery = await mkdtemp(join(to, '.legacy-visuals-'))
    try {
      await rename(from, join(recovery, 'files'))
    } finally {
      await removeIfEmpty(recovery)
    }
  }
}

/** Best effort: failed work stays under the legacy root for the next install to retry. */
export async function migrateLegacyNativeChatVisualsFolders(
  stateDirectory: string,
  logger: StructuredAgentSessionLogger
): Promise<void> {
  const legacyRoot = join(stateDirectory, LEGACY_ROOT_NAME)
  const root = nativeChatScratchRootFor(stateDirectory)
  try {
    if ((await presenceOf(legacyRoot)) !== 'directory') {
      return
    }
    const folders = (await readdir(legacyRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && isNativeChatScratchFolderName(entry.name)
    )
    if (folders.length > 0) {
      if ((await presenceOf(root)) === 'other') {
        logger.warn('the chat scratch root is not a directory; pre-rename visuals stay put', {
          scope: SCOPE,
          root
        })
        return
      }
      await mkdir(root, { recursive: true })
    }
    for (const folder of folders) {
      const from = join(legacyRoot, folder.name)
      const to = join(root, folder.name)
      try {
        const destination = await presenceOf(to)
        if (destination === 'absent') {
          // Set grace before moving so a timestamp failure leaves the source retryable.
          const now = new Date()
          await utimes(from, now, now)
          await rename(from, to)
        } else if (destination === 'directory') {
          await mergeFolder(from, to)
        }
      } catch (error) {
        logger.warn('a pre-rename chat visuals folder could not be moved', {
          scope: SCOPE,
          folder: folder.name,
          error
        })
      }
    }
    await removeIfEmpty(legacyRoot)
  } catch (error) {
    logger.warn('pre-rename chat visuals folders could not be moved', { scope: SCOPE, error })
  }
}
