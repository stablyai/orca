/** Declare permissions for every method; rpc-caller-scope.ts grants them per caller.
 * Workspace already runs host-user code; separate tiers allow narrower callers to refuse terminal-equivalent operations. Mobile has a method allowlist.
 * Paired runtime clients need a pairing-time desktop-control grant and never receive pairing-admin. */
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
