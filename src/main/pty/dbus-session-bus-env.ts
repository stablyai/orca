import {
  CANONICAL_USER_RUNTIME_DIR,
  resolveUserRuntimeDir
} from '../daemon/daemon-cgroup-scope'

const DISABLED_SESSION_BUS_ADDRESS = 'disabled:'

/**
 * Chromium sets `DBUS_SESSION_BUS_ADDRESS=disabled:` when it starts without a session bus, and
 * service hardening can set the same marker. Headless serve then passes it into the daemon and
 * every shell or agent it spawns, so `systemctl --user` and `systemd-run --user` fail with
 * "Connection refused" although the user bus is healthy.
 *
 * Only the exact marker is changed. It becomes the address of the bus that
 * `resolveUserRuntimeDir` finds (the per-UID runtime dir first, then `XDG_RUNTIME_DIR`), the
 * same resolution the durable daemon scope uses. When no bus is reachable, the env stays as it
 * is. An explicit address, not a deleted variable, because shells can carry an
 * `XDG_RUNTIME_DIR` that points at a private dir with no bus in it.
 */
export function repairDisabledSessionBusEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  canonicalRuntimeDir: string | null = CANONICAL_USER_RUNTIME_DIR
): void {
  if (platform !== 'linux' || env.DBUS_SESSION_BUS_ADDRESS !== DISABLED_SESSION_BUS_ADDRESS) {
    return
  }
  const runtimeDir = resolveUserRuntimeDir(env, canonicalRuntimeDir)
  if (!runtimeDir) {
    return
  }
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`
}
