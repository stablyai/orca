import { RuntimeClientError } from '../runtime-client'

/** `--unread` / `--read` as `worktree.set`'s `isUnread`; absent leaves it unchanged. */
export function getOptionalWorktreeUnreadFlag(
  flags: Map<string, string | boolean>
): boolean | undefined {
  const unread = flags.get('unread')
  const read = flags.get('read')
  // Why: `--unread=x` and `--read x` parse as values and would otherwise be silently dropped.
  for (const [name, value] of [
    ['unread', unread],
    ['read', read]
  ] as const) {
    if (typeof value === 'string') {
      throw new RuntimeClientError('invalid_argument', `--${name} takes no value.`)
    }
  }
  if (unread === true && read === true) {
    throw new RuntimeClientError('invalid_argument', 'Choose either --unread or --read, not both.')
  }
  if (unread === true) {
    return true
  }
  return read === true ? false : undefined
}
