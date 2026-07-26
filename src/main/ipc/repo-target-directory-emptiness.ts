import { opendir } from 'node:fs/promises'

export async function isRepoTargetDirectoryEmpty(targetPath: string): Promise<boolean> {
  const directory = await opendir(targetPath, { bufferSize: 1 })
  try {
    return (await directory.read()) === null
  } finally {
    await directory.close().catch(() => {
      // The OS may already have closed a fully consumed directory stream.
    })
  }
}
