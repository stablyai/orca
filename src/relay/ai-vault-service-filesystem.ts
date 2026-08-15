import { lstat, readdir } from 'node:fs/promises'
import type { RemoteSessionFilesystemProvider } from '../main/ai-vault/remote-session-scanner-types'
import { readRelayFileContent } from './fs-handler-file-read'

export function createRelayAiVaultFilesystemProvider(): RemoteSessionFilesystemProvider {
  return {
    async readDir(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    },
    readFile: readRelayFileContent,
    async stat(filePath) {
      const stats = await lstat(filePath)
      return {
        size: stats.size,
        type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
        mtime: stats.mtimeMs,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino,
        nlink: stats.nlink
      }
    }
  }
}
