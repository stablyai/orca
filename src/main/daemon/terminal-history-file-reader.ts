import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
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
