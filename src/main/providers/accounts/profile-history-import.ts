import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

export async function copyProfileHistory(
  sourceHome: string,
  destinationHome: string,
  names: readonly (string | { source: string; destination: string })[],
  onFile?: (file: string) => void,
  options: { skipExisting?: boolean } = {}
): Promise<void> {
  if (
    process.platform === 'win32' &&
    (parseWslUncPath(sourceHome) || parseWslUncPath(destinationHome))
  ) {
    throw new Error('WSL history import is not supported yet. Import credentials only.')
  }
  const source = await realpath(resolve(sourceHome))
  const destination = await realpath(destinationHome)
  const offset = relative(source, destination)
  if (!offset || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))) {
    throw new Error('The imported account home must be outside the source home.')
  }
  const copy = async (from: string, to: string): Promise<void> => {
    let entry
    try {
      entry = await lstat(from)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return
      }
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        'This profile history contains links. Choose a home with private session folders.'
      )
    }
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const child of await readdir(from)) {
        await copy(join(from, child), join(to, child))
      }
      return
    }
    if (!entry.isFile()) {
      throw new Error('Profile history contains an unsupported file type.')
    }
    try {
      await copyFile(from, to, constants.COPYFILE_EXCL)
    } catch (error) {
      if (
        options.skipExisting &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        return
      }
      throw error
    }
    onFile?.(from)
  }
  for (const name of names) {
    await copy(
      join(source, typeof name === 'string' ? name : name.source),
      join(destination, typeof name === 'string' ? name : name.destination)
    )
  }
}
