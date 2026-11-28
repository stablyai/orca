import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { renameWithWindowsRetry } from '../../filesystem/windows-rename-retry'

export type PluginAtomicWriteOptions = { mode?: number }

export async function writePluginFileAtomically(
  target: string,
  contents: string,
  options?: PluginAtomicWriteOptions
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: options?.mode })
    await renameWithWindowsRetry(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
