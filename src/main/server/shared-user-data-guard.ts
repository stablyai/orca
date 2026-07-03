import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Warn when the headless server is about to share its userData directory with a
 * desktop Orca install. The desktop app assumes it is the single writer of
 * orca-data.json (it takes a single-instance lock); a node server writing the
 * same files concurrently can race/corrupt settings, the device registry, and
 * the E2EE keypair.
 *
 * This is the same shared-userData property today's Electron `orca serve` has,
 * but a node server is more likely to be run casually on a desktop machine, so
 * surface it. We warn rather than refuse: pointing at a separate dir (the
 * intended container/VM usage) is one env var away, and a hard refusal would
 * block legitimate single-user setups.
 */
export function warnIfSharingDesktopUserData(options: {
  userDataPath: string
  /** True when the operator explicitly chose the dir (--user-data / env var). */
  explicitlyConfigured: boolean
}): void {
  if (options.explicitlyConfigured) {
    return
  }
  // orca-data.json is the desktop app's primary store; its presence in the
  // default dir means a desktop install very likely owns this directory.
  if (!existsSync(join(options.userDataPath, 'orca-data.json'))) {
    return
  }
  console.warn(
    [
      '[orca-server] WARNING: using the default Orca userData directory, which',
      `already contains a desktop install's data (${options.userDataPath}).`,
      'Running the headless server against the same directory as the desktop app',
      'can corrupt settings, paired devices, and the E2EE keypair.',
      'Set ORCA_USER_DATA_PATH (or --user-data <dir>) to an isolated directory.'
    ].join(' ')
  )
}
