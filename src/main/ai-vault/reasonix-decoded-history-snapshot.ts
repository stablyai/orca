import { reasonixSessionLayout } from '../../shared/reasonix-session-paths'
import { openTranscriptReadStream, wslGatedLstat } from '../native-chat/wsl-transcript-fs-access'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { reasonixHistoryAccess } from './session-scanner-reasonix-access'
import { projectReasonixHistory } from './session-scanner-reasonix-projection'

export const MAX_REASONIX_HISTORY_SNAPSHOT_BYTES = 2 * 1024 * 1024

export async function readReasonixDecodedHistorySnapshot(
  path: string,
  signal?: AbortSignal
): Promise<{ content: string; isBinary: false; decodedReasonixHistory: true }> {
  const layout = reasonixSessionLayout(path)
  if (!layout) {
    throw new Error('Not a canonical Reasonix session log')
  }
  const host = getRemoteHostPlatform(isWindowsAbsolutePathLike(path) ? 'win32-x64' : 'linux-x64')
  const access = await reasonixHistoryAccess(
    {
      stat: async (file) => {
        const stat = await wslGatedLstat(file, 'exact', signal)
        return {
          size: stat.size,
          mtime: stat.mtimeMs,
          type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file'
        }
      },
      readTranscriptBytes: (file) =>
        openTranscriptReadStream(file, { regularFile: true }, 'exact', signal)
    },
    host,
    path,
    signal
  )
  const projection = await projectReasonixHistory(
    openTranscriptReadStream(path, { regularFile: true }, 'exact', signal),
    access.readContent,
    signal
  )
  const records = [
    {
      type: 'reasonix-history',
      sessionId: layout.sessionId,
      createdAt: access.createdAt,
      cwd: access.cwd,
      title: projection.title,
      model: projection.model
    },
    ...projection.messages.map(({ record, timestamp }) => ({ ...record, timestamp }))
  ]
  const lines: string[] = []
  let size = 0
  for (const record of records) {
    signal?.throwIfAborted()
    const line = `${JSON.stringify(record)}\n`
    size += Buffer.byteLength(line)
    if (size > MAX_REASONIX_HISTORY_SNAPSHOT_BYTES) {
      throw new Error('Decoded Reasonix history exceeds the 2 MiB Open log limit')
    }
    lines.push(line)
  }
  return { content: lines.join(''), isBinary: false, decodedReasonixHistory: true }
}
