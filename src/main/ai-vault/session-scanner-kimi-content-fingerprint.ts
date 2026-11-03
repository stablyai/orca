import { createHash } from 'node:crypto'
import { wslGatedReadFile, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { kimiSessionWirePaths } from './session-scanner-kimi-paths'
import { parseJsonObject } from './session-scanner-values'

// Versioned only for Kimi: old cached rows reparse without discarding any other agent's history.
export async function kimiSessionContentFingerprint(
  path: string,
  signal?: AbortSignal
): Promise<string> {
  const state = parseJsonObject(await wslGatedReadFile(path, 'utf-8', 'scan', signal)) ?? {}
  const identity: (string | number | null)[][] = []
  for (const wire of kimiSessionWirePaths(path, state)) {
    try {
      const stat = await wslGatedStat(wire, 'scan', signal)
      identity.push([wire, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size])
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        identity.push([wire, null])
      } else {
        throw error
      }
    }
  }
  return `kimi-v2-1:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}
