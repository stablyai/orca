import type { RuntimeFileOpenPosition } from '../../shared/runtime-file-contracts'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export function getFileOpenPosition(
  flags: Map<string, string | boolean>
): RuntimeFileOpenPosition | undefined {
  for (const name of ['line', 'column']) {
    if (flags.get(name) === '') {
      throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
    }
  }
  const line = getOptionalPositiveIntegerFlag(flags, 'line')
  const column = getOptionalPositiveIntegerFlag(flags, 'column')
  for (const [name, value] of [
    ['line', line],
    ['column', column]
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`)
    }
  }
  if (line === undefined) {
    if (column !== undefined) {
      throw new RuntimeClientError('invalid_argument', '--column requires --line.')
    }
    return undefined
  }
  return column === undefined ? { line } : { line, column }
}
