/** Everything a workspace owns on its execution host that outlives a client. */
export const OWNED_SESSION_KINDS = ['pty', 'structured-chat', 'host-browser', 'launch'] as const
export type OwnedSessionKind = (typeof OWNED_SESSION_KINDS)[number]

export type OwnedSessionTeardownEntryPoint =
  | 'worktree-removal'
  | 'folder-removal'
  | 'project-removal'
  | 'sleep'
  | 'disconnect'

/** `stop-pending-28445`: decided, but the stop itself lands with #28445. */
type OwnedSessionTeardownDecision = 'stop' | 'retain' | 'stop-pending-28445'

const REMOVAL = {
  pty: 'stop',
  'structured-chat': 'stop',
  'host-browser': 'stop',
  launch: 'stop'
} as const

/**
 * What each entry point does to each kind. A new kind or entry point is a compile error here
 * until someone decides. Disconnect is loss of contact, never evidence of exit, so it stops nothing.
 */
export const OWNED_SESSION_TEARDOWN = {
  'worktree-removal': REMOVAL,
  'folder-removal': REMOVAL,
  'project-removal': REMOVAL,
  // Sleep keeps tabs, so pages and launch records survive to wake.
  sleep: {
    pty: 'stop',
    'structured-chat': 'stop-pending-28445',
    'host-browser': 'retain',
    launch: 'retain'
  },
  disconnect: {
    pty: 'retain',
    'structured-chat': 'retain',
    'host-browser': 'retain',
    launch: 'retain'
  }
} as const satisfies Record<
  OwnedSessionTeardownEntryPoint,
  Record<OwnedSessionKind, OwnedSessionTeardownDecision>
>

export function teardownStops(
  entryPoint: OwnedSessionTeardownEntryPoint,
  kind: OwnedSessionKind
): boolean {
  return OWNED_SESSION_TEARDOWN[entryPoint][kind] === 'stop'
}
