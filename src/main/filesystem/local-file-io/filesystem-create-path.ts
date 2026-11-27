import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { NEW_IPYNB_CONTENT } from '../../../shared/editor/notebooks/new-ipynb-content'
import { isENOENT } from './filesystem-path-containment'

export async function createLocalFile(filePath: string): Promise<void> {
  const name = basename(filePath)
  const content = name.toLowerCase().endsWith('.ipynb') ? NEW_IPYNB_CONTENT : ''
  await mkdir(dirname(filePath), { recursive: true })
  try {
    await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    throw createPathError(error, name)
  }
}

/**
 * Creates `filePath` holding `sourcePath`'s bytes, refusing any existing entry (a link included).
 * The bytes go to a hidden file of our own beside it first, so the name only ever holds the whole
 * file and nothing else writing that name can mix with our copy. A host crash mid-copy can leave
 * that hidden `.orca-upload-*` file, never a short file under the real name.
 */
export async function createLocalFileFromSource(
  sourcePath: string,
  filePath: string
): Promise<void> {
  const name = basename(filePath)
  // No leaf in the name: a long file name plus a suffix could pass the folder's name limit.
  const tempPath = join(dirname(filePath), `.orca-upload-${randomUUID()}`)
  try {
    // 'wx' makes the temp ours alone, so removing it below can't take anyone else's file.
    const handle = await open(tempPath, 'wx').catch((error: unknown) => {
      throw createPathError(error, name)
    })
    await pipeline(createReadStream(sourcePath), handle.createWriteStream())
    await publishNoClobber(tempPath, filePath).catch((error: unknown) => {
      throw createPathError(error, name)
    })
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

// What link() answers on a volume without hard links (EISDIR is Windows' ERROR_INVALID_FUNCTION).
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EISDIR'])

// A hard link is the one portable create that is atomic and fails on a taken name. A volume
// without them (exFAT, some network shares) refuses: a check-then-rename could replace a file
// another program creates in between.
async function publishNoClobber(tempPath: string, filePath: string): Promise<void> {
  try {
    await link(tempPath, filePath)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (!NO_HARD_LINKS.has(code)) {
      throw error
    }
    throw new Error(
      `Can't add '${basename(filePath)}' here: this drive can't create files safely`,
      {
        cause: error
      }
    )
  }
}

function createPathError(error: unknown, name: string): unknown {
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'EEXIST') {
      return new Error(`A file or folder named '${name}' already exists in this location`)
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return new Error(`Permission denied: unable to create '${name}'`)
    }
  }
  return error
}

/** Non-atomic existence check for directory creation. */
export async function assertNotExists(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
    throw new Error(
      `A file or folder named '${basename(targetPath)}' already exists in this location`
    )
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
}
