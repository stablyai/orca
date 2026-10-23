/**
 * Which directory a POSIX host's orcad state hangs off when several machines share one `$HOME`
 * (an NFS home across a cluster) (#29059).
 *
 * Everything orcad keeps on a host — install slots, the PID and readiness files, activation
 * record, locks, runtime store and data root — names one machine's processes, and a PID is only
 * evidence on the machine that issued it. So the first machine to claim a home keeps the login
 * home's `~/.orca-remote` and `~/.orca` unchanged (no migration for single-machine installs); any
 * other machine gets a complete tree of its own under `~/.orca-remote/hosts/<key>/`. Even the
 * immutable install stays per machine: the runtime store's GC judges "in use" from processes it
 * can see, so a store shared across machines could be collected under another machine's server.
 */
import { createHash } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { ORCAD_ACTIVATION_FILENAME } from '../activation/orcad-activation-record'
import { parseDarwinPlatformUuid } from '../../persistence/profile-state/profile-state-access-identity'
import {
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

/** Under `~/.orca-remote`: names the one machine that owns the login home's orcad state. */
export const ORCAD_MACHINE_CLAIM_FILENAME = 'orcad-machine.json'
/** Under `~/.orca-remote`: one orcad home per other machine sharing this `$HOME`. */
export const ORCAD_MACHINE_HOMES_DIRNAME = 'hosts'
export const ORCAD_MACHINE_CLAIM_SCHEMA_VERSION = 1

const SECTION = '__ORCA_MACHINE_HOME_SECTION__'
const CLAIM_ABSENT = 'ABSENT'
const CLAIM_PRESENT = 'PRESENT'
const RECORD_MAX_BYTES = 4096
const ACCESS_ROOT = '.orca/.profile-state-access'
const INSTALLED = 'INSTALLED'
// What `stat -f -c %T` (GNU and busybox) names a local disk filesystem; anything else may be shared.
const LOCAL_FILESYSTEM_TYPES = new Set([
  'ext2/ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'bcachefs',
  'f2fs',
  'jfs',
  'reiserfs',
  'nilfs',
  'tmpfs',
  'ramfs',
  'overlayfs',
  'ecryptfs',
  'msdos',
  'vfat',
  'exfat',
  'hfsplus'
])

type OrcadMachineIdentity = {
  /** Short, path-safe hash; the raw identity never lands on disk. */
  key: string
  /** What the data root's profile-state owners record, to recognise another machine's. */
  machineIdentity: string
  hostname: string | null
}

type OrcadMachineClaimRead =
  | { state: 'absent' }
  | { state: 'present'; machineKey: string }
  | { state: 'unreadable'; reason: string }

export type OrcadMachineHomeProbe = {
  loginHome: string
  identity: OrcadMachineIdentity | null
  claim: OrcadMachineClaimRead
  /** Profile-state owners (live orcads, or crashed ones) in the login home's data root. */
  dataRootOwners: readonly {
    host: string | null
    machineIdentity: string | null
  }[]
  /** Keys that already have a machine home under `~/.orca-remote/hosts/`. */
  machineHomeKeys: readonly string[]
  /** An orcad was already activated from the login home. */
  loginHomeInstalled: boolean
  /** The login home sits on a local disk, so no other machine can have run that orcad. */
  homeOnLocalDisk: boolean
}

type OrcadMachineHomeDecision =
  | { kind: 'login-home' }
  | { kind: 'claim'; machineKey: string }
  | { kind: 'machine-home'; machineKey: string }
  /** A pre-claim install on a shared home that no record attributes to a machine. */
  | { kind: 'unresolved'; machineKey: string; cause: OrcadMachineOwnershipUnresolvedCause }

/** A stopped install left no owner; an older orcad's owner recorded no machine identity. */
type OrcadMachineOwnershipUnresolvedCause = 'stopped-install' | 'unattributed-owner'

/**
 * Reads the login home, this machine's identity, the claim, and who holds the shared data root,
 * in one exec. Identity sources match `profile-state-access-identity.ts`, so the two agree.
 */
export function orcadMachineHomeProbeCommand(host: RemoteHostPlatform): string {
  const claim = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}`)}`
  const access = `"$HOME"/${quotePosixShell(ACCESS_ROOT)}`
  const homes = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_HOMES_DIRNAME}`)}`
  const activation = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_ACTIVATION_FILENAME}`)}`
  return [
    `printf '%s\\n' "$HOME"; echo ${SECTION};`,
    host.os === 'darwin'
      ? // Bare first so a test (or a host that moved it) can supply its own ioreg.
        '{ ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null ||' +
        ' /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null; } | grep IOPlatformUUID;'
      : 'cat /etc/machine-id 2>/dev/null;',
    `echo; echo ${SECTION}; uname -n 2>/dev/null; echo; echo ${SECTION};`,
    // An empty claim is one a full disk cut short; the claim command replaces it.
    `if { [ ! -e ${claim} ] && [ ! -L ${claim} ]; } || { [ -f ${claim} ] && [ ! -s ${claim} ]; };`,
    `then echo ${CLAIM_ABSENT};`,
    `elif [ -f ${claim} ]; then echo ${CLAIM_PRESENT}; head -c ${RECORD_MAX_BYTES} ${claim}; echo;`,
    `else echo UNREADABLE; fi; echo ${SECTION};`,
    `for f in ${access}/participants/*/*.owner ${access}/maintenance/*.owner; do`,
    `[ -f "$f" ] && { head -c ${RECORD_MAX_BYTES} "$f"; echo; }; done; echo ${SECTION};`,
    `ls -1 ${homes} 2>/dev/null; echo ${SECTION};`,
    `[ -e ${activation} ] && echo ${INSTALLED}; echo ${SECTION};`,
    // macOS `stat -f` takes a format, not a filesystem; its df source still names the device.
    host.os === 'darwin' ? '' : `stat -f -c %T "$HOME" 2>/dev/null; echo ${SECTION};`,
    `df -P "$HOME" 2>/dev/null | tail -n 1; true`
  ].join(' ')
}

export function parseOrcadMachineHomeProbe(
  output: string,
  host: RemoteHostPlatform
): OrcadMachineHomeProbe {
  const sections = output.split(new RegExp(`^${SECTION}$`, 'mu'))
  if (sections.length !== (host.os === 'darwin' ? 8 : 9)) {
    throw new Error('orcad machine-home probe returned no verifiable answer')
  }
  const [homeRaw, machineRaw, hostnameRaw, claimRaw, ownersRaw, homesRaw, installedRaw] = sections
  const filesystemType = host.os === 'darwin' ? '' : sections[7].trim()
  const dfSource = sections.at(-1)?.trim().split(/\s+/u)[0] ?? ''
  const loginHome = normalizeRemoteHome(homeRaw, host)
  if (!validateRemoteHome(loginHome, host)) {
    throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
  }
  return {
    loginHome,
    identity: orcadMachineIdentity(host, machineRaw.trim(), hostnameRaw.trim()),
    claim: parseClaimSection(claimRaw.trim()),
    dataRootOwners: ownersRaw
      .split('\n')
      .map((line) => parseOwnerLine(line.trim()))
      .filter((owner) => owner !== null),
    machineHomeKeys: homesRaw
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => /^[a-f0-9]{16}$/u.test(name)),
    loginHomeInstalled: installedRaw.trim() === INSTALLED,
    // Without a filesystem type, only a device path is evidence of a local disk.
    homeOnLocalDisk: filesystemType
      ? LOCAL_FILESYSTEM_TYPES.has(filesystemType)
      : dfSource.startsWith('/dev/')
  }
}

/**
 * The same machine identity the profile-state owners record: `/etc/machine-id` on Linux, the
 * hardware UUID on macOS. Neither changes when the host is renamed or a container is recreated
 * over a persistent home. A host without one keeps the login home, as before (#29059).
 */
export function orcadMachineIdentity(
  host: RemoteHostPlatform,
  machineRaw: string,
  hostnameRaw: string
): OrcadMachineIdentity | null {
  const machineIdentity =
    host.os === 'darwin'
      ? parseDarwinPlatformUuid(machineRaw)
      : /^[a-f0-9]{32}$/u.test(machineRaw) && !/^0+$/u.test(machineRaw)
        ? machineRaw
        : null
  if (!machineIdentity) {
    return null
  }
  const key = createHash('sha256')
    .update(`${host.os}:${machineIdentity}`)
    .digest('hex')
    .slice(0, 16)
  const hostname = /^[\x21-\x7e]{1,255}$/u.test(hostnameRaw) ? hostnameRaw : null
  return { key, machineIdentity, hostname }
}

function parseClaimSection(raw: string): OrcadMachineClaimRead {
  if (raw === CLAIM_ABSENT) {
    return { state: 'absent' }
  }
  if (!raw.startsWith(CLAIM_PRESENT)) {
    return { state: 'unreadable', reason: 'the claim is not a regular file' }
  }
  return parseOrcadMachineClaim(raw.slice(CLAIM_PRESENT.length).trim())
}

export function parseOrcadMachineClaim(raw: string): OrcadMachineClaimRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unreadable', reason: 'the claim is not JSON' }
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schemaVersion' in parsed &&
    parsed.schemaVersion === ORCAD_MACHINE_CLAIM_SCHEMA_VERSION &&
    'machineKey' in parsed &&
    typeof parsed.machineKey === 'string' &&
    /^[a-f0-9]{16}$/u.test(parsed.machineKey)
  ) {
    return { state: 'present', machineKey: parsed.machineKey }
  }
  return { state: 'unreadable', reason: 'the claim has an unknown shape' }
}

function parseOwnerLine(line: string): OrcadMachineHomeProbe['dataRootOwners'][number] | null {
  if (!line.startsWith('{')) {
    return null
  }
  try {
    const owner: unknown = JSON.parse(line)
    if (typeof owner !== 'object' || owner === null) {
      return null
    }
    return {
      host: 'host' in owner && typeof owner.host === 'string' ? owner.host : null,
      machineIdentity:
        'machineIdentity' in owner && typeof owner.machineIdentity === 'string'
          ? owner.machineIdentity
          : null
    }
  } catch {
    // A torn or foreign file is not evidence of another machine.
    return null
  }
}

/** Whether a data-root owner is this machine, another one, or cannot be told apart. */
function ownerMachine(
  owner: OrcadMachineHomeProbe['dataRootOwners'][number],
  identity: OrcadMachineIdentity,
  host: RemoteHostPlatform
): 'this' | 'foreign' | 'unknown' {
  if (owner.machineIdentity) {
    return owner.machineIdentity.toLowerCase() === identity.machineIdentity ? 'this' : 'foreign'
  }
  // An owner too old to record its machine is judged by hostname.
  if (!owner.host || !identity.hostname) {
    return 'unknown'
  }
  if (owner.host === identity.hostname) {
    return 'this'
  }
  // A macOS hostname follows the network, so a different one may still be this Mac.
  return host.os === 'darwin' ? 'unknown' : 'foreign'
}

/**
 * An unclaimed home is claimed unless a live (or crashed) orcad from another machine holds its
 * data root: that one is the install's owner, and claiming it here would judge its PIDs on the
 * wrong machine. A machine that already has its own home keeps it, so a later claim cannot move
 * it off a server still running there. An unreadable claim throws: guessing can strand a server.
 * A cleanly stopped install leaves no owner, and an older orcad's owner may name no machine
 * (macOS hostnames drift), so on a home that may be shared its machine is unknown: claiming it
 * could hand one machine's pairing, projects and instance lock to another.
 */
export function decideOrcadMachineHome(
  probe: OrcadMachineHomeProbe,
  host: RemoteHostPlatform
): OrcadMachineHomeDecision {
  const { identity, claim } = probe
  if (!identity) {
    return { kind: 'login-home' }
  }
  if (claim.state === 'unreadable') {
    throw new Error(
      `orcad cannot tell which machine owns ${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}: ${claim.reason}`
    )
  }
  if (claim.state === 'present') {
    return claim.machineKey === identity.key
      ? { kind: 'login-home' }
      : { kind: 'machine-home', machineKey: identity.key }
  }
  const owners = probe.dataRootOwners.map((owner) => ownerMachine(owner, identity, host))
  if (probe.machineHomeKeys.includes(identity.key) || owners.includes('foreign')) {
    return { kind: 'machine-home', machineKey: identity.key }
  }
  if (probe.homeOnLocalDisk) {
    return { kind: 'claim', machineKey: identity.key }
  }
  // Claiming another machine's install would judge its PIDs here and admit a second writer.
  if (owners.includes('unknown')) {
    return { kind: 'unresolved', machineKey: identity.key, cause: 'unattributed-owner' }
  }
  return probe.loginHomeInstalled && owners.length === 0
    ? { kind: 'unresolved', machineKey: identity.key, cause: 'stopped-install' }
    : { kind: 'claim', machineKey: identity.key }
}

/** Names the one-line claim the user can run on the machine that set the server up. */
export function orcadMachineOwnershipUnresolvedMessage(
  machineKey: string,
  hostname: string | null,
  cause: OrcadMachineOwnershipUnresolvedCause = 'stopped-install'
): string {
  const claim = JSON.stringify({ schemaVersion: ORCAD_MACHINE_CLAIM_SCHEMA_VERSION, machineKey })
  const path = `~/${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}`
  const why =
    cause === 'stopped-install'
      ? 'that stopped server left no record of its own'
      : 'the older Orca server there recorded only a hostname, which does not identify its machine'
  return (
    `Orca can't tell which machine set up the Orca server in ~/${RELAY_REMOTE_DIR}: ` +
    `this home may be shared by several machines, and ${why}. ` +
    'If another machine set it up, connect to that one and run the command shown there. ' +
    `If ${hostname ?? 'this machine'} set it up, run this on it, then reconnect: ` +
    `mkdir -p ~/${RELAY_REMOTE_DIR} && printf '%s' '${claim}' > ${path}`
  )
}

export function orcadMachineHomeDir(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ORCAD_MACHINE_HOMES_DIRNAME, machineKey)
}

/**
 * A sibling of `~/.orca`, not inside the machine home: orcad binds its runtime socket in the data
 * root, and a deeper path would cross the Unix socket length limit on long cluster home paths.
 */
export function orcadMachineDataRoot(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, `.orca-${machineKey.slice(0, 8)}`)
}
