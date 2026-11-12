import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../../../shared/file-content/node-bounded-file-reader'

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
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  return (await readNodeFileWithinLimit(filePath, maxBytes, { signal })).buffer
}

export async function readTerminalHistoryTextAsync(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  return (await readTerminalHistoryBufferAsync(filePath, maxBytes, signal)).toString('utf8')
}

export async function readTerminalHistoryJsonAsync(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<unknown> {
  const text = await readTerminalHistoryTextAsync(filePath, maxBytes, signal)
  signal?.throwIfAborted()
  return JSON.parse(text)
}
