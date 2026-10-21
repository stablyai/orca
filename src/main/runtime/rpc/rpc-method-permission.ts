/**
 * What a method lets its caller do to this Orca, declared on every method definition.
 *
 * The dispatcher grants each caller kind a set of these (rpc-caller-scope.ts), so a new method
 * cannot ship without someone deciding which callers may reach it.
 *
 * `workspace` means the caller can run code as this host's user: it opens terminals and starts
 * agents here. Anything a terminal command could do anyway (browsing directories, installing
 * skills, changing launch env or SSH targets) is therefore not a boundary for a `workspace`
 * caller. Those stay separate tiers so a narrower row (an SSH host's CLI) can refuse them; mobile
 * is gated by its own method-name allowlist instead. For a paired runtime client the real
 * boundaries are `desktop-control` (granted per device at pairing) and `pairing-admin` (never
 * granted to it).
 */
export type RpcMethodPermission =
  /** Projects, worktrees, terminals, files, git, browser, orchestration and integrations; equals
   *  running commands as this host's user. */
  | 'workspace'
  /** Drives this machine's own desktop: clicks, keys and app state outside Orca. */
  | 'desktop-control'
  /** Adds, removes or switches agent and integration accounts and their credentials. */
  | 'accounts-admin'
  /** Changes Orca settings. */
  | 'settings-write'
  /** Installs, publishes or removes agent skills. */
  | 'skills-admin'
  /** Pairing offers, relay credentials and push registration for paired devices. */
  | 'pairing-admin'
  /** Updates, managed servers, SSH connections, plugins and network tunnels on this host. */
  | 'host-admin'
  /** Changes only the caller's own paired-device credential (never another device's). */
  | 'device-self'

/** Administrative permissions a paired runtime client holds only when granted at pairing time. */
export const RUNTIME_DEVICE_GRANTS = [
  'desktop-control'
] as const satisfies readonly RpcMethodPermission[]
export type RuntimeDeviceGrant = (typeof RUNTIME_DEVICE_GRANTS)[number]

export const RPC_METHOD_PERMISSIONS: readonly RpcMethodPermission[] = [
  'workspace',
  'desktop-control',
  'accounts-admin',
  'settings-write',
  'skills-admin',
  'pairing-admin',
  'host-admin',
  'device-self'
]
