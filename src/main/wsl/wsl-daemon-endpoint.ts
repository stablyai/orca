import { PROTOCOL_VERSION } from '../daemon/daemon-protocol-version'
import { proveWslDaemonIncarnationExited } from './wsl-daemon-incarnation'
import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { desktopDaemonBundleDir } from '../daemon/daemon-bun-runtime'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { prepareWslGuestOwner } from './wsl-guest-owner-preparation'
import { WSL_GUEST_ARTIFACT_INSTALL_SCRIPT } from './wsl-guest-artifact-install-script'
import { WSL_DAEMON_START_SCRIPT } from './wsl-daemon-start-script'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { readWslDistributionIdentity } from './wsl-distribution-identity'
import type {
  PersistedWslDaemonEndpoint,
  WslDaemonIncarnation
} from '../../shared/wsl-daemon-recovery'
import type { WslPtyOwner } from '../../shared/wsl-pty-id'

export type PreparedWslDaemonEndpoint = Readonly<{
  endpoint: Readonly<PersistedWslDaemonEndpoint>
  owner: Readonly<WslPtyOwner>
  entry: string
  path: string
  artifactId: string
}>

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const runtimeEnvArgs = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'BUN_OPTIONS',
  'BUN_INSPECT',
  'ELECTRON_RUN_AS_NODE'
].flatMap((key) => ['-u', key])

/** The platform-neutral daemon bundle runs with the verified guest-native Bun runtime. */
export async function prepareWslDaemonEndpoint(
  distro: string,
  profileScope: string,
  signal?: AbortSignal
): Promise<PreparedWslDaemonEndpoint> {
  if (!profileScope) {
    throw new Error('WSL daemon requires a profile scope')
  }
  distro = distro.trim().toLowerCase()
  const { distributionId, userName, userId, platform, libc, runtime, environment, execution } =
    await prepareWslGuestOwner(distro, signal)
  const directory = desktopDaemonBundleDir()
  const entryName = 'daemon-entry.js'
  const files = [{ name: entryName, sha256: hash(await readFile(join(directory, entryName))) }]
  const target = `${platform}-${libc}` as const
  const artifactId = hash(
    JSON.stringify({ runtime: ORCAD_BUN_RELEASE_ASSETS[target].executableSha256, files })
  )
  const home = environment.home
  const ownerId = hash(
    JSON.stringify({
      distributionId,
      userId,
      userName,
      home,
      profileScope,
      runtime,
      envBinary: environment.envBinary
    })
  )
  const artifactRoot = posix.join(home, '.cache/orca/terminal-daemons')
  const guestDirectory = posix.join(artifactRoot, artifactId)
  const ownerDirectory = posix.join(
    home,
    '.orca-wsl',
    ownerId.slice(0, 20),
    artifactId.slice(0, 20)
  )
  const socket = posix.join(ownerDirectory, 'd.sock')
  if (Buffer.byteLength(posix.join(ownerDirectory, '.p0000000000')) > 100) {
    throw new Error('WSL home path is too long for a private terminal socket')
  }
  const source = await execution.run({
    program: 'wslpath',
    args: ['-a', '-u', directory],
    loginPath: 'none'
  })
  const installed = await execution.run({
    program: environment.envBinary,
    args: [
      ...runtimeEnvArgs,
      runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      WSL_GUEST_ARTIFACT_INSTALL_SCRIPT,
      JSON.stringify({
        source,
        artifactRoot,
        directory: guestDirectory,
        ownerDirectory,
        files,
        userId,
        home
      })
    ],
    loginPath: 'none'
  })
  if (installed !== 'ready') {
    throw new Error('WSL daemon artifact preparation did not finish')
  }
  return Object.freeze({
    endpoint: Object.freeze({
      distro,
      entry: posix.join(guestDirectory, entryName),
      serverBuildId: artifactId,
      protocolVersion: PROTOCOL_VERSION,
      distributionId,
      userName,
      userId,
      home,
      envBinary: environment.envBinary,
      runtime,
      socket,
      tokenPath: posix.join(ownerDirectory, 'token')
    }),
    owner: Object.freeze({ distro, relayBuildId: `daemon+${artifactId}+${ownerId}` }),
    entry: posix.join(guestDirectory, entryName),
    path: environment.path,
    artifactId
  })
}

/** The daemon itself arbitrates concurrent launches; contact failure never authorizes replacement. */
export async function startPreparedWslDaemonOwner(
  prepared: PreparedWslDaemonEndpoint,
  signal?: AbortSignal
): Promise<void> {
  await startWslDaemonOwner(prepared.endpoint, prepared.path, signal)
}

/** A retained endpoint can restart only after its admitted process incarnation exited. */
export async function startRetainedWslDaemonOwner(
  endpoint: PersistedWslDaemonEndpoint,
  incarnation: WslDaemonIncarnation | undefined,
  signal?: AbortSignal
): Promise<void> {
  await proveWslDaemonIncarnationExited(endpoint, incarnation, signal)
  await startWslDaemonOwner(endpoint, undefined, signal)
}

async function startWslDaemonOwner(
  endpoint: PersistedWslDaemonEndpoint,
  path: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  if ((await readWslDistributionIdentity(endpoint.distro)) !== endpoint.distributionId) {
    throw new Error('WSL distribution was replaced; refusing to start a different terminal owner')
  }
  const execution = createRunningWslRuntimeRunner(endpoint.distro, signal, endpoint.userName)
  const result = await execution.run({
    program: endpoint.envBinary,
    args: [
      ...runtimeEnvArgs,
      endpoint.runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      WSL_DAEMON_START_SCRIPT,
      JSON.stringify({ ...endpoint, path })
    ],
    loginPath: path === undefined ? 'preferred' : 'none'
  })
  if (result !== 'started' && result !== 'existing') {
    throw new Error('WSL terminal daemon could not be started')
  }
}
