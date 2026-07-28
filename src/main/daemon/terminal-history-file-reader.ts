import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/memory-safety/node-bounded-file-reader'

export function readTerminalHistoryBuffer(filePath: string, maxBytes: number): Buffer {
  return readNodeFileSyncWithinLimit(filePath, maxBytes).buffer
}

export function readTerminalHistoryText(filePath: string, maxBytes: number): string {
  return readTerminalHistoryBuffer(filePath, maxBytes).toString('utf8')
}

// Why no JSON structure pre-scan here: checkpoint.json and meta.json are our own
// writer's output, not untrusted input — the byte cap still bounds the read and a
// corrupt file fails JSON.parse into every caller's existing catch. Untrusted JSON
// still goes through assertJsonTextStructureWithinLimits.
export function readTerminalHistoryJson<T>(filePath: string, maxBytes: number): T {
  return JSON.parse(readTerminalHistoryText(filePath, maxBytes)) as T
}

// Why: cold-restore payload reads must not block the main thread, but need the
// same byte bound as the sync readers.
export async function readTerminalHistoryBufferAsync(
  filePath: string,
  maxBytes: number
): Promise<Buffer> {
  return (await readNodeFileWithinLimit(filePath, maxBytes)).buffer
}

export async function readTerminalHistoryTextAsync(
  filePath: string,
  maxBytes: number
): Promise<string> {
  return (await readTerminalHistoryBufferAsync(filePath, maxBytes)).toString('utf8')
}

export async function readTerminalHistoryJsonAsync<T>(
  filePath: string,
  maxBytes: number
): Promise<T> {
  return JSON.parse(await readTerminalHistoryTextAsync(filePath, maxBytes)) as T
}
