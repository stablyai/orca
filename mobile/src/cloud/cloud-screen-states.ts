import type { CloudWorkspaceStatus } from './cloud-control-plane-client'

// Which state a cloud screen shows while its workspace isn't in hand. Pure, so each branch is tested.

export type CloudMissingState = 'signin' | 'loading' | 'unreachable' | 'gone'

/**
 * The workspace screen without its workspace. Not connected (enrollment null) means the list query
 * never runs: a share link opened on a fresh phone must ask to sign in, not spin forever. A refetch
 * after an error shows the spinner again.
 */
export function cloudMissingState(args: {
  enrollment: unknown | null | undefined
  isPending: boolean
  isFetching: boolean
  isError: boolean
}): CloudMissingState {
  if (args.enrollment === null) {
    return 'signin'
  }
  if (args.enrollment === undefined || args.isFetching || (args.isPending && !args.isError)) {
    return 'loading'
  }
  return args.isError ? 'unreachable' : 'gone'
}

export type CloudHostGate = 'wait' | 'pass' | 'asleep'

/**
 * Before a paired host's page loads: `wait` while it isn't known yet whether this host is an asleep
 * cloud workspace; `asleep` only for a workspace the registry says is asleep; anything else (not a
 * cloud host, not connected, registry unreachable, awake) passes through to the page.
 */
export function cloudHostGate(args: {
  /** undefined while the host → workspace lookup runs; null when it's not a cloud workspace. */
  sandboxId: string | null | undefined
  enrollment: unknown | null | undefined
  isPending: boolean
  isError: boolean
  status: CloudWorkspaceStatus | null
}): CloudHostGate {
  if (args.sandboxId === undefined) {
    return 'wait'
  }
  if (args.sandboxId === null || args.enrollment === null || args.isError) {
    return 'pass'
  }
  if (args.enrollment === undefined || args.isPending) {
    return 'wait'
  }
  return args.status === 'sleeping' ? 'asleep' : 'pass'
}

export type CloudNumberLinkState = 'signin' | 'found' | 'missing'

/**
 * A W-number link (orca://cloud/<org>/W-123). Only the control plane can say which workspace it
 * names, so a phone not connected to Orca Cloud asks to sign in, like a share link does, rather
 * than calling the workspace private or deleted. A malformed link is missing either way.
 */
export function cloudNumberLinkState(args: {
  validLink: boolean
  enrolled: boolean
  sandboxId: string | null
}): CloudNumberLinkState {
  if (!args.validLink) {
    return 'missing'
  }
  if (!args.enrolled) {
    return 'signin'
  }
  return args.sandboxId ? 'found' : 'missing'
}
