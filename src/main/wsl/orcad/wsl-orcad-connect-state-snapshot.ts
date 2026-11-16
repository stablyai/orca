/**
 * The connect snapshot of `orcad-connect-state-snapshot`, plus orcad's instance lock and the guest
 * identity of the pid it names, which WSL adoption checks before its fence.
 */
import type { OrcadActivationRecord } from '../../managed-server/activation/orcad-activation-record'
import { orcadActivationPath } from '../../managed-server/activation/orcad-activation-record-store'
import {
  orcadActivationFenceLockDir,
  orcadActivationTransactionPath
} from '../../managed-server/activation/orcad-activation-transaction'
import {
  createOrcadConnectStateReader,
  orcadConnectStateFromSections,
  orcadConnectStateHints,
  parseOrcadStateFileSection,
  readOrcadStateFileSectionCommand,
  type OrcadConnectStateSnapshot
} from '../../managed-server/activation/orcad-connect-state-snapshot'
import { probeInstallLockExistsCommand } from '../../managed-server/install/remote-install-lock-commands'
import { ORCAD_LOCK_FILE_NAME } from '../../orcad/instance-lock/orcad-instance-lock'
import {
  parseWslGuestIdentity,
  wslGuestIdentityShellCommand,
  type WslGuestIdentity
} from '../execution/wsl-guest-process-identity'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const SECTION_END = '__ORCA_WSL_CONNECT_STATE_END__'

/** The guest's identity read for the pid the lock named, so liveness needs no second exec. */
export type WslOrcadLockHolderIdentity = { pid: number; guest: WslGuestIdentity }

export type WslOrcadInstanceLockRead =
  | { state: 'absent' }
  | { state: 'present'; raw: string; holder?: WslOrcadLockHolderIdentity }

export type WslOrcadConnectStateSnapshot = OrcadConnectStateSnapshot & {
  /** Null when the lock could not be read; the caller then reads it itself. */
  instanceLock: WslOrcadInstanceLockRead | null
}

type SnapshotPaths = {
  activation: string
  transaction: string
  instanceLock: string
  fence: string
}

function snapshotPaths(host: RemoteHostPlatform, remoteHome: string, userDataDir: string) {
  return {
    activation: orcadActivationPath(host, remoteHome),
    transaction: orcadActivationTransactionPath(host, remoteHome),
    instanceLock: joinRemotePath(host, userDataDir, ORCAD_LOCK_FILE_NAME),
    fence: orcadActivationFenceLockDir(host, remoteHome)
  }
}

export function wslOrcadConnectStateCommand(
  host: RemoteHostPlatform,
  paths: SnapshotPaths
): string {
  const lock = quotePosixShell(paths.instanceLock)
  // The pid as digits only; the parser drops the identity unless it matches the parsed lock.
  const holderIdentity =
    `orca_lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${lock} 2>/dev/null | head -n 1); ` +
    `if [ -n "$orca_lock_pid" ]; then printf 'PID %s\\n' "$orca_lock_pid"; ` +
    `${wslGuestIdentityShellCommand('"$orca_lock_pid"')}; else printf '%s' NONE; fi; ` +
    `printf '\\n%s\\n' ${SECTION_END}`
  return [
    readOrcadStateFileSectionCommand(paths.activation, SECTION_END),
    readOrcadStateFileSectionCommand(paths.transaction, SECTION_END),
    readOrcadStateFileSectionCommand(paths.instanceLock, SECTION_END),
    holderIdentity,
    probeInstallLockExistsCommand(host, paths.fence)
  ].join('; ')
}

function withHolderIdentity(
  lock: { state: 'present'; raw: string },
  section: string
): WslOrcadInstanceLockRead {
  const match = /^PID (\d+)\n([\s\S]*)$/.exec(section)
  if (!match) {
    return lock
  }
  const pid = Number(match[1])
  const guest = parseWslGuestIdentity(match[2] ?? '')
  return guest && Number.isSafeInteger(pid) ? { ...lock, holder: { pid, guest } } : lock
}

/** Null unless the output has exactly the shape the command prints. */
export function parseWslOrcadConnectState(output: string): WslOrcadConnectStateSnapshot | null {
  const parts = output.split(`\n${SECTION_END}\n`)
  if (parts.length !== 5) {
    return null
  }
  const state = orcadConnectStateFromSections(parts[0] ?? '', parts[1] ?? '', parts[4])
  const instanceLock = parseOrcadStateFileSection(parts[2] ?? '')
  if (!state || !instanceLock) {
    return null
  }
  return {
    ...state,
    instanceLock:
      instanceLock.state === 'unreadable'
        ? null
        : instanceLock.state === 'present'
          ? withHolderIdentity(instanceLock, parts[3] ?? '')
          : instanceLock
  }
}

export function createWslOrcadConnectStateReader() {
  return createOrcadConnectStateReader({
    command: (target) =>
      wslOrcadConnectStateCommand(
        target.host,
        snapshotPaths(target.host, target.remoteHome, target.userDataDir)
      ),
    parse: parseWslOrcadConnectState
  })
}

/** Later steps take the snapshot's hints only while the record it read is still the one acted on. */
export function wslOrcadConnectStateHints(
  snapshot: WslOrcadConnectStateSnapshot | null,
  snapshotRecord: OrcadActivationRecord
) {
  const hints = orcadConnectStateHints(snapshot, snapshotRecord)
  return {
    instanceLock: (record: OrcadActivationRecord): WslOrcadInstanceLockRead | undefined =>
      hints.current(record)?.instanceLock ?? undefined,
    deployPreRead: hints.deployPreRead
  }
}
