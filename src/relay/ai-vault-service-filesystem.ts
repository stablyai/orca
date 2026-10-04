import { readRelayTranscriptBytes } from './ai-vault-transcript-stream'
import { lstat, readdir } from 'node:fs/promises'
import type { RemoteSessionFilesystemProvider } from '../main/ai-vault/remote-session-scanner-types'
import { readRelayFileContent } from './fs-handler-file-read'
import {
  createRelayOpenCodeReader,
  type RelayOpenCodeReaderOptions
} from './ai-vault-opencode-reader'

export function createRelayAiVaultFilesystemProvider(
  options: RelayOpenCodeReaderOptions = {}
): RemoteSessionFilesystemProvider & { dispose(): void } {
  const openCode = createRelayOpenCodeReader(options)
  return {
    openCode,
    dispose: () => openCode.dispose(),
    async readDir(dirPath) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
    },
    readFile: readRelayFileContent,
    readTranscriptBytes: readRelayTranscriptBytes,
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
