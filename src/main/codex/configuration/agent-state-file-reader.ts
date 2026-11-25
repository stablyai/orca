import { readNodeFileSyncWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import { assertJsonTextStructureWithinLimits } from '../../../shared/json-stream/json-text-structure-limit'
import { observeFileContent, observeFileReadError } from '../../filesystem/file-content-observation'

export const MAX_AGENT_STATE_FILE_BYTES = 4 * 1024 * 1024
export const MAX_AGENT_STATE_JSON_STRUCTURAL_TOKENS = 1_000_000
export const MAX_AGENT_STATE_JSON_NESTING_DEPTH = 128

export function readAgentStateFileSync(filePath: string): string {
  try {
    const buffer = readNodeFileSyncWithinLimit(filePath, MAX_AGENT_STATE_FILE_BYTES).buffer
    observeFileContent(filePath, buffer)
    return buffer.toString('utf8')
  } catch (error) {
    observeFileReadError(filePath, error)
    throw error
  }
}

export function readAgentStateJsonFileSync(filePath: string): unknown {
  const content = readAgentStateFileSync(filePath)
  assertJsonTextStructureWithinLimits(content, {
    structuralTokens: MAX_AGENT_STATE_JSON_STRUCTURAL_TOKENS,
    nestingDepth: MAX_AGENT_STATE_JSON_NESTING_DEPTH
  })
  return JSON.parse(content) as unknown
}
