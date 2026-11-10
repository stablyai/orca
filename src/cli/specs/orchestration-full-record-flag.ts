import type { CommandSpec } from '../args'

// Output is the concise agent view by default; --full prints the whole record Orca returned.
export function withFullRecordFlag(spec: CommandSpec): CommandSpec {
  if (spec.allowedFlags.includes('full')) {
    return spec
  }
  return {
    ...spec,
    usage: spec.usage.replace(/\[--json\]$/, '[--json] [--full]'),
    allowedFlags: [...spec.allowedFlags, 'full']
  }
}
