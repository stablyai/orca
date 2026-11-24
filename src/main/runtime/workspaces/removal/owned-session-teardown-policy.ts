/** Everything a workspace owns on its execution host that outlives a client. */
export const OWNED_SESSION_KINDS = ['pty', 'structured-chat', 'host-browser', 'launch'] as const
export type OwnedSessionKind = (typeof OWNED_SESSION_KINDS)[number]

export type OwnedSessionTeardownEntryPoint =
  | 'worktree-removal'
  | 'folder-removal'
  | 'project-removal'
  | 'sleep'
  | 'disconnect'

type OwnedSessionTeardownDecision = 'stop' | 'retain'

const REMOVAL = {
  pty: 'stop',
  'structured-chat': 'stop',
  'host-browser': 'stop',
  launch: 'stop'
} as const

/** Require an explicit policy for every entry point and session kind; disconnect stops nothing because lost contact proves no exit. */
export const OWNED_SESSION_TEARDOWN = {
  'worktree-removal': REMOVAL,
  'folder-removal': REMOVAL,
  'project-removal': REMOVAL,
  // Sleep keeps tabs, so pages and launch records survive to wake. Main stops the chats.
  sleep: {
    pty: 'stop',
    'structured-chat': 'stop',
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
