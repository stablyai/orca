import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function stageClipboardPublisher(source: string, userData: string): Promise<string> {
  const contents = await readFile(source)
  const fingerprint = createHash('sha256').update(contents).digest('hex')
  const directory = join(userData, 'clipboard-publishers')
  const executable = join(directory, fingerprint)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    if ((await readFile(executable)).equals(contents)) {
      await chmod(executable, 0o700)
      return executable
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  const temporary = join(directory, `${fingerprint}-${randomUUID()}`)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o700 })
    await rename(temporary, executable)
  } finally {
    await rm(temporary, { force: true })
  }
  return executable
}
