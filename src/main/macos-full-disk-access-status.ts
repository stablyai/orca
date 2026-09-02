import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DeveloperPermissionStatus } from '../shared/developer-permissions-types'

type ReadProbe = (filePath: string) => Promise<void>

async function openForRead(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r')
  await handle.close()
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

export async function probeMacosFullDiskAccess({
  homeDirectory = homedir(),
  readProbe = openForRead
}: {
  homeDirectory?: string
  readProbe?: ReadProbe
} = {}): Promise<DeveloperPermissionStatus> {
  const databasePath = join(
    homeDirectory,
    'Library',
    'Application Support',
    'com.apple.TCC',
    'TCC.db'
  )
  try {
    await readProbe(databasePath)
    return 'granted'
  } catch (error) {
    const code = errorCode(error)
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unknown'
  }
}

export async function getMacosFullDiskAccessStatus(): Promise<DeveloperPermissionStatus> {
  return process.platform === 'darwin' ? probeMacosFullDiskAccess() : 'unsupported'
}
