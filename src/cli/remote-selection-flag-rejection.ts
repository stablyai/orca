import { RuntimeClientError } from './runtime/types'

// Local-only command families reject explicit runtime selectors rather than silently ignoring them.
export const REMOTE_SELECTION_FLAGS = ['environment', 'pairing-code'] as const

/** suffix completes "--<flag> does not retarget …" with the command's actual scope. */
export function rejectRemoteSelectionFlags(
  flags: ReadonlyMap<string, string | boolean>,
  suffix: string,
  data?: Record<string, unknown>
): void {
  for (const flag of REMOTE_SELECTION_FLAGS) {
    if (flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `\`--${flag}\` does not retarget ${suffix}`,
        data
      )
    }
  }
}
