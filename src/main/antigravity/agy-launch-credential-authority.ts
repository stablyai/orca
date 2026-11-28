// Saved Antigravity accounts swap the host's own agy login: the one in the host's home, in the
// host's credential store. A launch whose environment points agy elsewhere (another home, the file
// store instead of the keyring, another Secret Service) reads a login no saved account names.

import { resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { isAntigravityFileStorageHostAsync } from './native-file-credentials'

/** A launch reads agy's login from another home or credential store than the host's own. */
export class AgyForeignCredentialAuthority extends Error {
  constructor() {
    super(
      'This agy launch uses a different credential authority from the selected Antigravity account.'
    )
    this.name = 'AgyForeignCredentialAuthority'
  }
}

// Chromium's `disabled:` and the `none:` marker name no usable bus, like an unset address.
const NO_SESSION_BUS_ADDRESSES = ['', 'autolaunch:', 'disabled:', 'none:']

/** The session bus a keyring client in `env` reaches: its address without the server's guid, or
 *  the runtime directory's default bus when it names none. */
function effectiveSessionBus(env: NodeJS.ProcessEnv): string {
  const address = env.DBUS_SESSION_BUS_ADDRESS ?? ''
  if (NO_SESSION_BUS_ADDRESSES.includes(address)) {
    return `unix:path=${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/bus`
  }
  return address
    .split(',')
    .filter((part) => !part.startsWith('guid='))
    .join(',')
}

type HostCredentialAuthority = {
  envToDelete?: readonly string[]
  platform?: NodeJS.Platform
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: () => string
}

/** Whether a launch with `env` reads another agy login than the host's own. */
export async function agyLaunchIsForeign(
  env: NodeJS.ProcessEnv,
  {
    envToDelete = [],
    platform = process.platform,
    hostEnv = process.env,
    hostHome = () => getAppEnvironment().getPath('home')
  }: HostCredentialAuthority = {}
): Promise<boolean> {
  if (envToDelete.some((key) => ['HOME', 'USERPROFILE'].includes(key))) {
    return true
  }
  const home = platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : (env.HOME ?? env.USERPROFILE)
  if (home && resolve(home) !== resolve(hostHome())) {
    return true
  }
  const fileStore = await isAntigravityFileStorageHostAsync(env)
  if (fileStore !== (await isAntigravityFileStorageHostAsync(hostEnv))) {
    return true
  }
  // Another session bus is another Secret Service, holding another login.
  return (
    platform === 'linux' && !fileStore && effectiveSessionBus(env) !== effectiveSessionBus(hostEnv)
  )
}

/** Throws `AgyForeignCredentialAuthority` unless a launch with `env` reads the host's own login. */
export async function assertHostCredentialAuthority(
  env: NodeJS.ProcessEnv,
  authority?: HostCredentialAuthority
): Promise<void> {
  if (await agyLaunchIsForeign(env, authority)) {
    throw new AgyForeignCredentialAuthority()
  }
}
