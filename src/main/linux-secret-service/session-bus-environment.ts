import { stat } from 'node:fs/promises'

// Chromium's `disabled:` and the `none:` marker name no usable bus, like an unset address.
const NO_SESSION_BUS_ADDRESSES = ['', 'autolaunch:', 'disabled:', 'none:']

/** Agent CLIs reach $XDG_RUNTIME_DIR/bus when the env names no bus; without it GLib tools would autolaunch a private bus. */
export async function secretServiceProcessEnvironment(): Promise<NodeJS.ProcessEnv> {
  // English stderr keeps callers' error matching locale-independent.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`
  const bus = `${runtimeDir}/bus`
  if (
    NO_SESSION_BUS_ADDRESSES.includes(env.DBUS_SESSION_BUS_ADDRESS ?? '') &&
    (await stat(bus).then(
      () => true,
      () => false
    ))
  ) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`
  }
  return env
}
