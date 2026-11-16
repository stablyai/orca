/**
 * One read of the activation state a connect checks before its fence: the activation record, the
 * transaction journal and the activation fence. Each consumer takes it only as a hint that lets it
 * skip a read whose answer would let it continue unchanged; anything else, and every fenced
 * decision, still reads the host.
 */
import {
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  type OrcadActivationReadResult,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { orcadActivationPath, readOrcadActivationRecord } from './orcad-activation-record-store'
import {
  orcadActivationFenceLockDir,
  orcadActivationTransactionPath,
  parseOrcadActivationTransaction
} from './orcad-activation-transaction'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { probeInstallLockExistsCommand } from '../install/remote-install-lock-commands'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { OrcadHostTransport } from '../install/orcad-host-transport'
import {
  isWindowsRemoteHost,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'

// The record stores' own caps; a larger file reads as unreadable, as theirs does.
const RECORD_MAX_BYTES = 64 * 1024
const SECTION_END = '__ORCA_CONNECT_STATE_END__'

export type OrcadConnectStateSnapshot = {
  activation: OrcadActivationReadResult
  transactionAbsent: boolean
  fenceOpen: boolean
}

export type OrcadConnectStateTarget = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  remoteHome: string
  userDataDir: string
}

type StateFileSection =
  | { state: 'absent' }
  | { state: 'present'; raw: string }
  | { state: 'unreadable' }

/** PRESENT only when the whole file was read; a failed or oversized read is UNREADABLE. */
export function readOrcadStateFileSectionCommand(path: string, sectionEnd: string): string {
  // `$(cat)` drops trailing newlines, so raws are not byte-exact; every consumer parses JSON.
  const file = quotePosixShell(path)
  return (
    `if [ ! -e ${file} ] && [ ! -L ${file} ]; then printf '%s' ABSENT; ` +
    `elif [ -f ${file} ] && size=$(wc -c < ${file}) && [ "$size" -le ${RECORD_MAX_BYTES} ] && body=$(cat ${file}); ` +
    `then printf 'PRESENT\\n%s' "$body"; else printf '%s' UNREADABLE; fi; ` +
    `printf '\\n%s\\n' ${sectionEnd}`
  )
}

export function parseOrcadStateFileSection(text: string): StateFileSection | null {
  if (text === 'ABSENT') {
    return { state: 'absent' }
  }
  if (text === 'UNREADABLE') {
    return { state: 'unreadable' }
  }
  return text.startsWith('PRESENT\n') ? { state: 'present', raw: text.slice(8) } : null
}

/** Null unless the record and journal sections parse and the fence answered LOCKED or OPEN. */
export function orcadConnectStateFromSections(
  activationText: string,
  transactionText: string,
  fenceText: string | undefined
): OrcadConnectStateSnapshot | null {
  const activation = parseOrcadStateFileSection(activationText)
  const transaction = parseOrcadStateFileSection(transactionText)
  const fence = fenceText?.trim()
  if (!activation || !transaction || (fence !== 'LOCKED' && fence !== 'OPEN')) {
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
    fenceOpen: fence === 'OPEN'
  }
}

export function orcadConnectStateCommand(host: RemoteHostPlatform, remoteHome: string): string {
  return [
    readOrcadStateFileSectionCommand(orcadActivationPath(host, remoteHome), SECTION_END),
    readOrcadStateFileSectionCommand(orcadActivationTransactionPath(host, remoteHome), SECTION_END),
    probeInstallLockExistsCommand(host, orcadActivationFenceLockDir(host, remoteHome))
  ].join('; ')
}

export function parseOrcadConnectState(output: string): OrcadConnectStateSnapshot | null {
  const parts = output.split(`\n${SECTION_END}\n`)
  return parts.length === 3
    ? orcadConnectStateFromSections(parts[0] ?? '', parts[1] ?? '', parts[2])
    : null
}

export type OrcadConnectStateRead<S extends OrcadConnectStateSnapshot> = {
  command: (target: OrcadConnectStateTarget) => string
  parse: (output: string) => S | null
}

export const ORCAD_CONNECT_STATE_READ: OrcadConnectStateRead<OrcadConnectStateSnapshot> = {
  command: (target) => orcadConnectStateCommand(target.host, target.remoteHome),
  parse: parseOrcadConnectState
}

/**
 * Reads the activation record through the snapshot, keeping the snapshot for later hints. Falls
 * back to the plain record read (which fails closed on an unreadable record) when it can't answer.
 */
export function createOrcadConnectStateReader<S extends OrcadConnectStateSnapshot>(
  read: OrcadConnectStateRead<S>
) {
  let snapshot: S | null = null
  return {
    // No hints when the record came from the fallback read rather than the snapshot.
    snapshot: (): S | null => (snapshot?.activation.state === 'unreadable' ? null : snapshot),
    readActivationRecord: async (
      target: OrcadConnectStateTarget
    ): Promise<OrcadActivationRecord> => {
      if (!isWindowsRemoteHost(target.host)) {
        // A failed snapshot only costs the per-file reads; an aborted signal stops those too.
        const output = await execOrcadRemote(target, read.command(target)).catch(() => null)
        snapshot = output === null ? null : read.parse(output)
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
export function orcadConnectStateHints<S extends OrcadConnectStateSnapshot>(
  snapshot: S | null,
  snapshotRecord: OrcadActivationRecord
) {
  const current = (record: OrcadActivationRecord): S | null =>
    record === snapshotRecord ? snapshot : null
  return {
    current,
    deployPreRead: (record: OrcadActivationRecord) => {
      const fresh = current(record)
      return fresh ? { preRead: { record, fenceOpen: fresh.fenceOpen } } : {}
    }
  }
}
