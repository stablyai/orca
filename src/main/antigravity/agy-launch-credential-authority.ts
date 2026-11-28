// Saved Antigravity accounts swap the host's own agy login: the one in the host's home, in the
// host's credential store. A launch whose environment points agy elsewhere (another home, the file
// store instead of the keyring, another Secret Service) reads a login no saved account names.
// Only a provable difference counts: a launch wrongly called foreign stops following switches.

import { realpath as realpathAsync } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { antigravityUsesFileStoreAsync } from './native-file-credentials'

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

function canonicalAddress(address: string): string | null {
  const colon = address.indexOf(':')
  if (colon <= 0) {
    return null
  }
  const transport = address.slice(0, colon)
  const pairs: string[] = []
  for (const pair of address.slice(colon + 1).split(',')) {
    if (!pair) {
      continue
    }
    const equals = pair.indexOf('=')
    if (equals <= 0) {
      return null
    }
    const key = pair.slice(0, equals)
    let value: string
    try {
      value = decodeURIComponent(pair.slice(equals + 1))
    } catch {
      return null
    }
    // The server's guid names no other bus.
    if (key === 'guid') {
      continue
    }
    if (transport === 'unix' && key === 'path') {
      value = posix.normalize(value).replace(/(.)\/+$/, '$1')
    }
    pairs.push(`${key}=${value}`)
  }
  return `${transport}:${pairs.sort().join(',')}`
}

/** The buses a keyring client in `env` tries, in order: `;` separates addresses, `,` their keys.
 *  No address means the runtime folder's bus. Null: a form this can't read. */
export function canonicalSessionBuses(env: NodeJS.ProcessEnv): string[] | null {
  const address = env.DBUS_SESSION_BUS_ADDRESS ?? ''
  const addresses = NO_SESSION_BUS_ADDRESSES.includes(address)
    ? [`unix:path=${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/bus`]
    : address.split(';').filter(Boolean)
  const canonical = addresses.map(canonicalAddress)
  return canonical.length > 0 && canonical.every((entry) => entry !== null)
    ? canonical.filter((entry): entry is string => entry !== null)
    : null
}

function sameBuses(launch: NodeJS.ProcessEnv, host: NodeJS.ProcessEnv): boolean {
  const [a, b] = [canonicalSessionBuses(launch), canonicalSessionBuses(host)]
  return !a || !b || (a.length === b.length && a.every((entry, index) => entry === b[index]))
}

/** One home in two spellings: compared resolved, then by real path, case-folded where the file
 *  system ignores case. A real path that can't be read leaves only the spelling to tell. */
async function sameHome(
  launch: string,
  host: string,
  platform: NodeJS.Platform,
  realpath: (path: string) => Promise<string>
): Promise<boolean> {
  const fold = (path: string) =>
    platform === 'darwin' || platform === 'win32' ? path.toLowerCase() : path
  const resolve = platform === 'win32' ? win32.resolve : posix.resolve
  if (fold(resolve(launch)) === fold(resolve(host))) {
    return true
  }
  const [a, b] = await Promise.all([launch, host].map((path) => realpath(path).catch(() => null)))
  return a !== null && b !== null && fold(a) === fold(b)
}

type HostCredentialAuthority = {
  envToDelete?: readonly string[]
  platform?: NodeJS.Platform
  hostEnv?: NodeJS.ProcessEnv
  hostHome?: () => string
  usesFileStore?: (env: NodeJS.ProcessEnv) => Promise<boolean>
  realpath?: (path: string) => Promise<string>
}

/** Whether a launch with `env` provably reads another agy login than the host's own. */
export async function agyLaunchIsForeign(
  env: NodeJS.ProcessEnv,
  {
    envToDelete = [],
    platform = process.platform,
    hostEnv = process.env,
    hostHome = () => getAppEnvironment().getPath('home'),
    usesFileStore = antigravityUsesFileStoreAsync,
    realpath = realpathAsync
  }: HostCredentialAuthority = {}
): Promise<boolean> {
  if (envToDelete.some((key) => ['HOME', 'USERPROFILE'].includes(key))) {
    return true
  }
  const home = platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : (env.HOME ?? env.USERPROFILE)
  if (home && !(await sameHome(home, hostHome(), platform, realpath))) {
    return true
  }
  const [fileStore, hostFileStore] = await Promise.all([usesFileStore(env), usesFileStore(hostEnv)])
  if (fileStore !== hostFileStore) {
    return true
  }
  // Both on the keyring: another session bus is another Secret Service, holding another login.
  return platform === 'linux' && !fileStore && !sameBuses(env, hostEnv)
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
