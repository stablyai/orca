import { unlink, writeFile } from 'node:fs/promises'

/** Replace the owned entry so a filesystem alias can never write through an immutable hardlink. */
export async function writeBrowserExtensionGeneratedFile(
  file: string,
  contents: string
): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }
  })
  await writeFile(file, contents, { flag: 'wx' })
}
