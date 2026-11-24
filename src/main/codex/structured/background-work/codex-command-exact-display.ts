// The exact command a Worker Dock dialog may show and copy: Codex's own shell presentation of a
// live command, accepted whole or not at all. Never sliced, normalized or repaired.

import { posixShellWords } from '../../../../shared/native-chat/tools/native-chat-tool-preview-prefix'
import { redactCodexCommand } from '../../history/rollouts/codex-command-presentation'

export const CODEX_EXACT_COMMAND_MAX_BYTES = 8 * 1024
const PROVIDER_NUL_SENTINEL = '<command included NUL byte>'
const PROVIDER_REDACTION_MARKER = '[REDACTED_SECRET]'
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** `<path>/bash|zsh|sh -c|-lc ` followed by the start of a single-quoted word. */
const WRAPPER_PREFIX = /^(?:\/[^\s'"\\]*\/)?(?:ba|z)?sh -l?c (?=')/
/** One or more single-quoted pieces joined only by `\'`: the whole remainder is one quoted word. */
const WHOLE_SINGLE_QUOTED = /^'[^']*'(?:\\''[^']*')*$/

/** Whole, well formed, nonblank, at most 8 KiB, with no NUL or provider/Orca redaction. */
export function codexExactCommandEligible(text: string): boolean {
  return (
    text.trim().length > 0 &&
    Buffer.byteLength(text, 'utf8') <= CODEX_EXACT_COMMAND_MAX_BYTES &&
    !LONE_SURROGATE.test(text) &&
    !text.includes('\0') &&
    !text.includes(PROVIDER_NUL_SENTINEL) &&
    !text.includes(PROVIDER_REDACTION_MARKER) &&
    // A secret Orca recognizes means these bytes were never shown verbatim; never store them.
    redactCodexCommand(text) === text
  )
}

/** The inner command of a strict whole-single-quoted POSIX shell wrapper, or null for any other text. */
export function decodeStrictShellWrapper(command: string): string | null {
  const prefix = WRAPPER_PREFIX.exec(command)
  if (!prefix) {
    return null
  }
  const rest = command.slice(prefix[0].length)
  if (!WHOLE_SINGLE_QUOTED.test(rest)) {
    return null
  }
  const words = posixShellWords(rest)
  return words?.length === 1 ? words[0]! : null
}

/** A fresh flat copy, so a retained value never pins a larger stream chunk it was sliced from. */
function owned(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string
}

/** The one value display and Copy share, or null when the command is not proven exact. A decoded
 *  wrapper must pass the same checks; a blank or blocked inner command falls back. */
export function codexExactCommandDisplay(command: string): string | null {
  if (!codexExactCommandEligible(command)) {
    return null
  }
  const inner = decodeStrictShellWrapper(command)
  if (inner === null) {
    return owned(command)
  }
  return codexExactCommandEligible(inner) ? owned(inner) : null
}
