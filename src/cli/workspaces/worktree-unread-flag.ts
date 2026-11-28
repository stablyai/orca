import { RuntimeClientError } from '../runtime/connection/types'

/** Reads a mutually exclusive on/off flag pair: true, false, or undefined when neither is passed. */
export function getExclusiveBooleanFlagPair(
  flags: Map<string, string | boolean>,
  on: string,
  off: string
): boolean | undefined {
  const onValue = flags.get(on)
  const offValue = flags.get(off)
  // Reject valued booleans instead of silently ignoring --unread=x or --read x.
  for (const [name, value] of [
    [on, onValue],
    [off, offValue]
  ] as const) {
    if (typeof value === 'string') {
      throw new RuntimeClientError('invalid_argument', `--${name} takes no value.`)
    }
  }
  if (onValue === true && offValue === true) {
    throw new RuntimeClientError('invalid_argument', `Choose either --${on} or --${off}, not both.`)
  }
  if (onValue === true) {
    return true
  }
  return offValue === true ? false : undefined
}

export function getWorktreeReadFlags(flags: Map<string, string | boolean>): {
  isUnread?: boolean
  acknowledgeAttention?: true
} {
  const isUnread = getExclusiveBooleanFlagPair(flags, 'unread', 'read')
  if (isUnread === undefined) {
    return {}
  }
  return isUnread ? { isUnread } : { isUnread, acknowledgeAttention: true }
}

export function getWorktreePinFlags(flags: Map<string, string | boolean>): { isPinned?: boolean } {
  const isPinned = getExclusiveBooleanFlagPair(flags, 'pin', 'unpin')
  return isPinned === undefined ? {} : { isPinned }
}
