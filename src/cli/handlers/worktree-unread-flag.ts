import { RuntimeClientError } from '../runtime-client'

/** `--unread` / `--read` as `worktree.set`'s `isUnread`; absent leaves it unchanged. */
export function getOptionalWorktreeUnreadFlag(
  flags: Map<string, string | boolean>
): boolean | undefined {
  const unread = flags.get('unread')
  const read = flags.get('read')
  // Why: `read` is not a registered switch, so `--read x` parses as a value and would otherwise be dropped.
  if (typeof read === 'string') {
    throw new RuntimeClientError('invalid_argument', '--read takes no value.')
  }
  if (unread === true && read === true) {
    throw new RuntimeClientError('invalid_argument', 'Choose either --unread or --read, not both.')
  }
  if (unread === true) {
    return true
  }
  return read === true ? false : undefined
}
