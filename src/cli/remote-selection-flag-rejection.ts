import { RuntimeClientError } from './runtime/types'

/**
 * The flags that pick which runtime answers a command. `shouldIgnoreRemoteSelection`
 * in `src/cli/index.ts` pins some command families to the local runtime, which drops
 * these silently — so every pinned family pairs the pin with this rejection instead.
 */
export const REMOTE_SELECTION_FLAGS = ['environment', 'pairing-code'] as const

/**
 * Fails a pinned command that was given a runtime selector, rather than answering
 * for a machine the caller did not name. `suffix` completes "`--<flag>` does not
 * retarget …" and should say what the command answers for and where to run it.
 */
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
