import type { RuntimeFileOpenPosition } from '../../shared/file-access/runtime-editor-file-open'
import { getOptionalPositiveIntegerFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/types'

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
