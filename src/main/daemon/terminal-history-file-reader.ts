import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'

export function readTerminalHistoryBuffer(filePath: string, maxBytes: number): Buffer {
  return readNodeFileSyncWithinLimit(filePath, maxBytes).buffer
}

export function readTerminalHistoryText(filePath: string, maxBytes: number): string {
  return readTerminalHistoryBuffer(filePath, maxBytes).toString('utf8')
}

// Byte bounds protect local checkpoints; structural pre-scans reject legitimate link-dense history.
export function readTerminalHistoryJson<T>(filePath: string, maxBytes: number): T {
  return JSON.parse(readTerminalHistoryText(filePath, maxBytes)) as T
}

// Cold-restore payload reads must yield the main thread while retaining the byte bound.
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
