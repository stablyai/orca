import { access, readFile, realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ExternalChromiumLaunch } from './external-chromium-browser-session'

export type ExternalChromiumProfileEnvironment = {
  platform: NodeJS.Platform
  /** snapd mounts snaps at /snap, or /var/lib/snapd/snap on distros without a root /snap. */
  snapRoots: readonly string[]
  /** `snap run` places per-user snap data under the passwd home, not $HOME. */
  homePath: () => string
}

const HOST_ENVIRONMENT: ExternalChromiumProfileEnvironment = {
  platform: process.platform,
  snapRoots: ['/snap', '/var/lib/snapd/snap'],
  homePath: () => userInfo().homedir
}

async function strictSnapNameUnderRoot(
  executableTarget: string,
  appName: string,
  snapRoot: string
): Promise<string | null> {
  try {
    if ((await realpath(join(snapRoot, 'bin', appName))) !== executableTarget) {
      return null
    }
    const snapName = appName.split('.')[0]
    const manifest: unknown = parseYaml(
      await readFile(join(snapRoot, snapName, 'current', 'meta', 'snap.yaml'), 'utf8')
    )
    const confinement =
      typeof manifest === 'object' && manifest !== null && 'confinement' in manifest
        ? manifest.confinement
        : undefined
    // snap.yaml omits confinement for strict snaps; classic and devmode snaps can write anywhere.
    return confinement === undefined || confinement === 'strict' ? snapName : null
  } catch {
    return null
  }
}

/** Names the strictly confined snap that `executablePath` launches through snapd, if any. */
async function strictSnapNameForExecutable(
  executablePath: string,
  environment: ExternalChromiumProfileEnvironment
): Promise<string | null> {
  if (environment.platform !== 'linux') {
    return null
  }
  let executableTarget: string
  try {
    executableTarget = await realpath(executablePath)
  } catch {
    return null
  }
  // snapd dispatches on argv0's basename, which must name a launcher symlink in <root>/bin.
  const appName = basename(executablePath)
  for (const snapRoot of environment.snapRoots) {
    const snapName = await strictSnapNameUnderRoot(executableTarget, appName, snapRoot)
    if (snapName) {
      return snapName
    }
  }
  return null
}

// Chromium writes Local State only after it has run on a profile, so the snap can already write there.
async function hasChromiumUsedProfile(profilePath: string): Promise<boolean> {
  try {
    await access(join(profilePath, 'Local State'))
    return true
  } catch {
    return false
  }
}

/** Strict snaps cannot write dot-directories in $HOME, so their profile lives in the snap's common data. */
export async function resolveExternalChromiumProfilePath(
  launch: Pick<ExternalChromiumLaunch, 'executablePath' | 'provider'>,
  statePath: string,
  sessionIdentity: string,
  environment: ExternalChromiumProfileEnvironment = HOST_ENVIRONMENT
): Promise<string> {
  const stateProfilePath = join(statePath, `browser-${launch.provider}`)
  const snapName = await strictSnapNameForExecutable(launch.executablePath, environment)
  if (!snapName || (await hasChromiumUsedProfile(stateProfilePath))) {
    return stateProfilePath
  }
  return join(environment.homePath(), 'snap', snapName, 'common', `orca-browser-${sessionIdentity}`)
}
