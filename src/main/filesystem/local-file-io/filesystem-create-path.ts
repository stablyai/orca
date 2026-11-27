import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { NEW_IPYNB_CONTENT } from '../../../shared/editor/notebooks/new-ipynb-content'
import { isENOENT } from './filesystem-path-containment'

export async function createLocalFile(filePath: string): Promise<void> {
  const name = basename(filePath)
  const content = name.toLowerCase().endsWith('.ipynb') ? NEW_IPYNB_CONTENT : ''
  await mkdir(dirname(filePath), { recursive: true })
  try {
    await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EEXIST') {
        throw new Error(`A file or folder named '${name}' already exists in this location`)
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: unable to create '${name}'`)
      }
    }
    throw error
  }
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
