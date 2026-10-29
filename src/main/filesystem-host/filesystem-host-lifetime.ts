import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import {
  configureFilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from './filesystem-host-read-client'
import { resolveFilesystemHostEntryPath } from './filesystem-host-entry-path'

let authority: FilesystemHostReadAuthority | null = null
export function initializeFilesystemHost(appPath: string, isPackaged: boolean): void {
  if (authority) {
    return
  }
  authority = new FilesystemHostReadAuthority({
    entryPath: resolveFilesystemHostEntryPath(appPath, isPackaged)
  })
  configureFilesystemHostReadAuthority(authority)
}
export async function disposeFilesystemHost(): Promise<void> {
  const owned = authority
  authority = null
  setFilesystemHostReadClientForTests(null)
  await owned?.dispose()
}
