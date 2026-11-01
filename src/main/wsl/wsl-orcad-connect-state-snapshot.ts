/**
 * One read of the activation state a WSL connect checks before its fence: the activation record,
 * the transaction journal, the activation fence and orcad's instance lock. Each consumer takes it
 * only as a hint that lets it skip a read whose answer would let it continue unchanged; anything
 * else, and every fenced decision, still reads the host.
 */
import {
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  type OrcadActivationReadResult,
  type OrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record'
import {
  orcadActivationPath,
  readOrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record-store'
import {
  orcadActivationFenceLockDir,
  orcadActivationTransactionPath,
  parseOrcadActivationTransaction
} from '../managed-server/activation/orcad-activation-transaction'
import { execOrcadRemote } from '../managed-server/install/orcad-remote-runtime-control'
import { probeInstallLockExistsCommand } from '../managed-server/install/remote-install-lock-commands'
import { ORCAD_LOCK_FILE_NAME } from '../orcad/orcad-instance-lock'
import {
  parseWslGuestIdentity,
  wslGuestIdentityShellCommand,
  type WslGuestIdentity
} from './wsl-guest-process-identity'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../ssh/ssh-remote-platform'

// The record stores' own caps; a larger file reads as unreadable, as theirs does.
const RECORD_MAX_BYTES = 64 * 1024
const SECTION_END = '__ORCA_WSL_CONNECT_STATE_END__'

/** The guest's identity read for the pid the lock named, so liveness needs no second exec. */
export type WslOrcadLockHolderIdentity = { pid: number; guest: WslGuestIdentity }

export type WslOrcadInstanceLockRead =
  | { state: 'absent' }
  | { state: 'present'; raw: string; holder?: WslOrcadLockHolderIdentity }

export type WslOrcadConnectStateSnapshot = {
  activation: OrcadActivationReadResult
  transactionAbsent: boolean
  /** Null when the lock could not be read; the caller then reads it itself. */
  instanceLock: WslOrcadInstanceLockRead | null
  fenceOpen: boolean
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
  // PRESENT only when the whole file was read; a failed or oversized read is UNREADABLE.
  // `$(cat)` drops trailing newlines, so raws are not byte-exact; every consumer parses JSON.
  const read = (path: string): string => {
    const file = quotePosixShell(path)
    return (
      `if [ ! -e ${file} ] && [ ! -L ${file} ]; then printf '%s' ABSENT; ` +
      `elif [ -f ${file} ] && size=$(wc -c < ${file}) && [ "$size" -le ${RECORD_MAX_BYTES} ] && body=$(cat ${file}); ` +
      `then printf 'PRESENT\\n%s' "$body"; else printf '%s' UNREADABLE; fi; ` +
      `printf '\\n%s\\n' ${SECTION_END}`
    )
  }
  const lock = quotePosixShell(paths.instanceLock)
  // The pid as digits only; the parser drops the identity unless it matches the parsed lock.
  const holderIdentity =
    `orca_lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${lock} 2>/dev/null | head -n 1); ` +
    `if [ -n "$orca_lock_pid" ]; then printf 'PID %s\\n' "$orca_lock_pid"; ` +
    `${wslGuestIdentityShellCommand('"$orca_lock_pid"')}; else printf '%s' NONE; fi; ` +
    `printf '\\n%s\\n' ${SECTION_END}`
  return [
    read(paths.activation),
    read(paths.transaction),
    read(paths.instanceLock),
    holderIdentity,
    probeInstallLockExistsCommand(host, paths.fence)
  ].join('; ')
}

type Section = { state: 'absent' } | { state: 'present'; raw: string } | { state: 'unreadable' }

function parseSection(text: string): Section | null {
  if (text === 'ABSENT') {
    return { state: 'absent' }
  }
  if (text === 'UNREADABLE') {
    return { state: 'unreadable' }
  }
  return text.startsWith('PRESENT\n') ? { state: 'present', raw: text.slice(8) } : null
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
  const [activation, transaction, instanceLock] = parts.slice(0, 3).map(parseSection)
  const fence = parts[4]?.trim()
  if (!activation || !transaction || !instanceLock || (fence !== 'LOCKED' && fence !== 'OPEN')) {
    return null
  }
  return {
    activation:
      activation.state === 'unreadable'
        ? { state: 'unreadable', reason: 'the connect snapshot could not read it' }
        : parseOrcadActivationRecord(activation.state === 'present' ? activation.raw : null),
    transactionAbsent:
      transaction.state !== 'unreadable' &&
      parseOrcadActivationTransaction(transaction.state === 'present' ? transaction.raw : null)
        .state === 'absent',
    instanceLock:
      instanceLock.state === 'unreadable'
        ? null
        : instanceLock.state === 'present'
          ? withHolderIdentity(instanceLock, parts[3] ?? '')
          : instanceLock,
    fenceOpen: fence === 'OPEN'
  }
}

/**
 * Reads the activation record through the snapshot, keeping the snapshot for later hints. Falls
 * back to the plain record read (which fails closed on an unreadable record) when it can't answer.
 */
export function createWslOrcadConnectStateReader() {
  let snapshot: WslOrcadConnectStateSnapshot | null = null
  return {
    // No hints when the record came from the fallback read rather than the snapshot.
    snapshot: (): WslOrcadConnectStateSnapshot | null =>
      snapshot?.activation.state === 'unreadable' ? null : snapshot,
    readActivationRecord: async (target: {
      conn: OrcadHostTransport
      host: RemoteHostPlatform
      signal?: AbortSignal
      remoteHome: string
      userDataDir: string
    }): Promise<OrcadActivationRecord> => {
      if (!isWindowsRemoteHost(target.host)) {
        const paths = snapshotPaths(target.host, target.remoteHome, target.userDataDir)
        // A failed snapshot only costs the per-file reads; an aborted signal stops those too.
        const output = await execOrcadRemote(
          target,
          wslOrcadConnectStateCommand(target.host, paths)
        ).catch(() => null)
        snapshot = output === null ? null : parseWslOrcadConnectState(output)
      }
      const activation = snapshot?.activation
      if (activation?.state === 'ok') {
        return activation.record
      }
      return activation?.state === 'absent'
        ? emptyOrcadActivationRecord()
        : readOrcadActivationRecord(target)
    }
  }
}

/** Later steps take the snapshot's hints only while the record it read is still the one acted on. */
export function wslOrcadConnectStateHints(
  snapshot: WslOrcadConnectStateSnapshot | null,
  snapshotRecord: OrcadActivationRecord
) {
  const current = (record: OrcadActivationRecord) => (record === snapshotRecord ? snapshot : null)
  return {
    instanceLock: (record: OrcadActivationRecord): WslOrcadInstanceLockRead | undefined =>
      current(record)?.instanceLock ?? undefined,
    deployPreRead: (record: OrcadActivationRecord) => {
      const fresh = current(record)
      return fresh ? { preRead: { record, fenceOpen: fresh.fenceOpen } } : {}
    }
  }
}
