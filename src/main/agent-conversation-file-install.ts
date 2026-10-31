import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errnoCodeOrUnknown } from '../shared/errno-code'
import {
  copySessionFileWithoutOverwrite,
  isAtomicNoReplaceUnsupportedError
} from './codex/codex-session-backfill-copy'

/** Make an agent's conversation file readable at `targetPath` too: a hardlink, else a copy.
 *  Never replaces a different file already there. */
export async function installConversationFileWithoutOverwrite(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const sourceStat = await lstat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Legacy rollout source is not a regular file.')
  }
  await mkdir(dirname(targetPath), { recursive: true })
  try {
    await link(sourcePath, targetPath)
  } catch (linkError) {
    if (isExistsError(linkError)) {
      await assertMatchingExistingTarget(sourcePath, targetPath)
      return
    }
    try {
      await copySessionFileWithoutOverwrite(sourcePath, targetPath)
    } catch (copyError) {
      if (isExistsError(copyError)) {
        await assertMatchingExistingTarget(sourcePath, targetPath)
        return
      }
      if (isAtomicNoReplaceUnsupportedError(copyError)) {
        throw new Error('The target filesystem cannot safely install this rollout.', {
          cause: copyError
        })
      }
      throw copyError
    }
  }
}

const RENAME_RETRY_MS = 150

/** Like `installConversationFileWithoutOverwrite`, but a stale copy at `targetPath` (one `sourcePath`
 *  grew past, as separate copies across filesystems do) is replaced. A copy that diverged is kept. */
export async function refreshConversationFileCopy(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const targetStat = await lstat(targetPath).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!targetStat) {
    await installConversationFileWithoutOverwrite(sourcePath, targetPath)
    return
  }
  const sourceStat = await lstat(sourcePath)
  if (
    !targetStat.isFile() ||
    (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) ||
    targetStat.size >= sourceStat.size ||
    !(await fileStartsWith(sourcePath, targetPath, targetStat.size))
  ) {
    return
  }
  const staged = `${targetPath}.${randomUUID()}.tmp`
  try {
    await link(sourcePath, staged).catch(() => copyFile(sourcePath, staged))
    await rename(staged, targetPath).catch(async (error: unknown) => {
      // Windows refuses a rename while a reader holds the file open; one short retry rides that out.
      if (!['EPERM', 'EBUSY'].includes(errnoCodeOrUnknown(error))) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS))
      await rename(staged, targetPath)
    })
  } finally {
    await rm(staged, { force: true })
  }
}

/** Whether the first `length` bytes of `filePath` equal `prefixPath`'s. */
async function fileStartsWith(filePath: string, prefixPath: string, length: number) {
  const [file, prefix] = await Promise.all([open(filePath, 'r'), open(prefixPath, 'r')])
  try {
    const chunk = 64 * 1024
    const left = Buffer.alloc(chunk)
    const right = Buffer.alloc(chunk)
    for (let offset = 0; offset < length; offset += chunk) {
      const size = Math.min(chunk, length - offset)
      const [a, b] = await Promise.all([
        file.read(left, 0, size, offset),
        prefix.read(right, 0, size, offset)
      ])
      if (
        a.bytesRead !== size ||
        b.bytesRead !== size ||
        !left.subarray(0, size).equals(right.subarray(0, size))
      ) {
        return false
      }
    }
    return true
  } finally {
    await Promise.all([file.close(), prefix.close()])
  }
}

async function assertMatchingExistingTarget(sourcePath: string, targetPath: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([lstat(sourcePath), lstat(targetPath)])
  if (
    !targetStat.isFile() ||
    targetStat.isSymbolicLink() ||
    sourceStat.size !== targetStat.size ||
    ((sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) &&
      (await fileDigest(sourcePath)) !== (await fileDigest(targetPath)))
  ) {
    throw new Error('A different rollout already occupies the real-home target path.')
  }
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function isExistsError(error: unknown): boolean {
  return errnoCodeOrUnknown(error) === 'EEXIST'
}
