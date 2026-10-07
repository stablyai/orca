import type {
  LineageTestPatternArgs,
  LineageTestPatternResult
} from '../../shared/fleet-lineage-types'
import { MAX_KEY_REGEX_LENGTH, MAX_TOWER_NAME_LENGTH } from '../../shared/lineage-ticket-keys'
import { extractKeysWithPattern } from './lineage-key-extraction'

export function testLineagePattern(args: LineageTestPatternArgs): LineageTestPatternResult {
  // hazard: IPC payloads are untrusted at runtime despite the static types
  const { towerName, keyRegex } = args ?? {}
  if (typeof towerName !== 'string' || towerName.length === 0) {
    return { keys: [], error: 'Tower name is required' }
  }
  if (typeof keyRegex !== 'string' || keyRegex.length === 0) {
    return { keys: [], error: 'Key pattern is required' }
  }
  if (towerName.length > MAX_TOWER_NAME_LENGTH) {
    return {
      keys: [],
      error: `Tower name is longer than ${MAX_TOWER_NAME_LENGTH} characters`
    }
  }
  if (keyRegex.length > MAX_KEY_REGEX_LENGTH) {
    return {
      keys: [],
      error: `Key pattern is longer than ${MAX_KEY_REGEX_LENGTH} characters`
    }
  }
  return extractKeysWithPattern(towerName, keyRegex)
}
