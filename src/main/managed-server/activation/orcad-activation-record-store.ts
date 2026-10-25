// Unreadable activation records must fail closed; treating them as absent could overwrite a live install and its rollback target.
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  ORCAD_ACTIVATION_FILENAME,
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationReadResult,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  readBoundedOrcadRemoteRecord,
  writeAtomicOrcadRemoteRecord
} from '../install/orcad-remote-record-file'

const ORCAD_ACTIVATION_RECORD_MAX_BYTES = 64 * 1024

type ActivationRecordTarget = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

function orcadActivationPath(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_ACTIVATION_FILENAME)
}

async function readActivationRecordState(
  options: ActivationRecordTarget
): Promise<OrcadActivationReadResult> {
  const read = await readBoundedOrcadRemoteRecord(
    options,
    orcadActivationPath(options.host, options.remoteHome),
    ORCAD_ACTIVATION_RECORD_MAX_BYTES
  )
  return read.state === 'absent' ? read : parseOrcadActivationRecord(read.raw)
}

export async function readOrcadActivationRecord(
  options: ActivationRecordTarget
): Promise<OrcadActivationRecord> {
  const parsed = await readActivationRecordState(options)
  if (parsed.state === 'ok') {
    return parsed.record
  }
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's orcad activation record: ${parsed.reason}`)
  }
  return emptyOrcadActivationRecord()
}

/** Refuse replacement of unreadable records, including schemas written by newer clients. */
export async function writeOrcadActivationRecord(
  options: ActivationRecordTarget,
  record: OrcadActivationRecord
): Promise<void> {
  const existing = await readActivationRecordState(options)
  if (existing.state === 'unreadable') {
    throw new Error(`Refusing to overwrite this host's orcad activation record: ${existing.reason}`)
  }
  await writeAtomicOrcadRemoteRecord(
    options,
    orcadActivationPath(options.host, options.remoteHome),
    serializeOrcadActivationRecord(record)
  )
}
