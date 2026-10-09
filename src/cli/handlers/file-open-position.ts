import type { RuntimeFileOpenPosition } from '../../shared/runtime-types'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

// Why: a column with no line has nowhere to land; refuse it rather than open at the top as if honored.
export function getFileOpenPosition(
  flags: Map<string, string | boolean>
): RuntimeFileOpenPosition | undefined {
  // Why: the number parser reads `--line=` as absent, which would open at the top and report success.
  for (const name of ['line', 'column']) {
    if (flags.get(name) === '') {
      throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
    }
  }
  const line = getOptionalPositiveIntegerFlag(flags, 'line')
  const column = getOptionalPositiveIntegerFlag(flags, 'column')
  if (line === undefined) {
    if (column !== undefined) {
      throw new RuntimeClientError('invalid_argument', '--column needs --line.')
    }
    return undefined
  }
  return column === undefined ? { line } : { line, column }
}
