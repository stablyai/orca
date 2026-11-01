import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeUnreadFlag } from './worktree-unread-flag'

export function getOptionalPinFlag(flags: Map<string, string | boolean>): boolean | undefined {
  for (const name of ['pin', 'unpin']) {
    // `--pin=true` parses as the string 'true', which would otherwise read as "flag absent"
    // and drop the write while the command still reports success.
    if (typeof flags.get(name) === 'string') {
      throw new RuntimeClientError('invalid_argument', `--${name} takes no value.`)
    }
  }
  const pin = flags.get('pin') === true
  const unpin = flags.get('unpin') === true
  if (pin && unpin) {
    throw new RuntimeClientError('invalid_argument', 'Choose either --pin or --unpin, not both.')
  }
  return pin || unpin ? pin : undefined
}

export function getWorktreeStateFlags(flags: Map<string, string | boolean>): {
  isUnread: boolean | undefined
  isPinned: boolean | undefined
} {
  return { isUnread: getOptionalWorktreeUnreadFlag(flags), isPinned: getOptionalPinFlag(flags) }
}
