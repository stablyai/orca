import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
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
 * Creates `filePath` holding `sourcePath`'s bytes. Any existing entry, a link included, refuses it;
 * the new file gets the folder's default mode, not the source's.
 */
export async function createLocalFileFromSource(
  sourcePath: string,
  filePath: string
): Promise<void> {
  const handle = await open(filePath, 'wx').catch((error: unknown) => {
    throw createPathError(error, basename(filePath))
  })
  try {
    await pipeline(createReadStream(sourcePath), handle.createWriteStream())
  } catch (error) {
    // Only this call could have created it: 'wx' refuses a path that already exists.
    await handle.close().catch(() => {})
    await rm(filePath, { force: true }).catch(() => {})
    throw error
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
