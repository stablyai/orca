import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

export const TERMINAL_HISTORY_JSON_MAX_STRUCTURAL_TOKENS = 1_000_000
export const TERMINAL_HISTORY_JSON_MAX_NESTING_DEPTH = 128

export function readTerminalHistoryBuffer(filePath: string, maxBytes: number): Buffer {
  return readNodeFileSyncWithinLimit(filePath, maxBytes).buffer
}

export function readTerminalHistoryText(filePath: string, maxBytes: number): string {
  return readTerminalHistoryBuffer(filePath, maxBytes).toString('utf8')
}

export function readTerminalHistoryJson<T>(filePath: string, maxBytes: number): T {
  const text = readTerminalHistoryText(filePath, maxBytes)
  assertJsonTextStructureWithinLimits(text, {
    structuralTokens: TERMINAL_HISTORY_JSON_MAX_STRUCTURAL_TOKENS,
    nestingDepth: TERMINAL_HISTORY_JSON_MAX_NESTING_DEPTH
  })
  return JSON.parse(text) as T
}

// Why: cold-restore payload reads must not block the main thread, but need the
// same byte and JSON-structure bounds as the sync readers.
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
  const text = await readTerminalHistoryTextAsync(filePath, maxBytes)
  assertJsonTextStructureWithinLimits(text, {
    structuralTokens: TERMINAL_HISTORY_JSON_MAX_STRUCTURAL_TOKENS,
    nestingDepth: TERMINAL_HISTORY_JSON_MAX_NESTING_DEPTH
  })
  return JSON.parse(text) as T
}
