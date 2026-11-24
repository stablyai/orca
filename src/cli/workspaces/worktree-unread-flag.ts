import { RuntimeClientError } from '../runtime/connection/types'

export function getWorktreeReadFlags(flags: Map<string, string | boolean>): {
  isUnread?: boolean
  acknowledgeAttention?: true
} {
  const unread = flags.get('unread')
  const read = flags.get('read')
  // Reject valued booleans instead of silently ignoring --unread=x or --read x.
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
    return { isUnread: true }
  }
  return read === true ? { isUnread: false, acknowledgeAttention: true } : {}
}
