import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { bestEffortFsyncDirectorySync } from '../../../shared/secure-file'
import {
  OrcadManagedStopAuthoritySchema,
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority
} from '../../../shared/orcad-managed-stop-authority'

type AdmissionRecord = {
  state: 'closed' | 'open'
  authority?: OrcadManagedStopAuthority
}

export class PtyOwnershipTransferAdmissionRecord {
  private readonly path: string
  private writeUnconfirmed = false

  constructor(
    private readonly directory: string,
    private readonly runtimeId: string
  ) {
    this.path = join(directory, 'pty-ownership-transfer-admission.json')
  }

  isClosed(): boolean {
    return this.read()?.state === 'closed'
  }

  assertClosedFor(authority: OrcadManagedStopAuthority): void {
    this.assertStateFor('closed', authority)
  }

  assertOpenFor(authority: OrcadManagedStopAuthority): void {
    this.assertStateFor('open', authority)
  }

  private assertStateFor(
    state: AdmissionRecord['state'],
    authority: OrcadManagedStopAuthority
  ): void {
    const requested = this.validateAuthority(authority)
    const current = this.read()
    if (
      this.writeUnconfirmed ||
      current?.state !== state ||
      !current.authority ||
      !sameOrcadManagedStopAuthority(current.authority, requested)
    ) {
      throw new Error(
        `pty_ownership_transfer_admission_${state === 'closed' ? 'closure' : 'reopening'}_unverifiable`
      )
    }
  }

  private read(): AdmissionRecord | null {
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    if (!stat.isFile() || stat.size > 32768) {
      throw new Error('pty_ownership_transfer_admission_record_invalid')
    }
    const record = JSON.parse(readFileSync(this.path, 'utf8'))
    if (
      (record?.version !== 1 && record?.version !== 2) ||
      record.runtimeId !== this.runtimeId ||
      (record.state !== 'closed' && record.state !== 'open')
    ) {
      throw new Error('pty_ownership_transfer_admission_record_invalid')
    }
    if (record.version === 1) {
      if (record.authority !== undefined) {
        throw new Error('pty_ownership_transfer_admission_record_invalid')
      }
      return { state: record.state }
    }
    const authority = this.validateAuthority(record.authority)
    return { state: record.state, authority }
  }

  close(authority?: OrcadManagedStopAuthority): void {
    const requested = authority === undefined ? undefined : this.validateAuthority(authority)
    const current = this.read()
    this.assertOwner(current, requested, current?.state === 'open' && !this.writeUnconfirmed)
    if (current?.state === 'closed' && !this.writeUnconfirmed) {
      return
    }
    this.write('closed', requested)
  }

  reopenAfterConfirmedNativeRefusal(authority?: OrcadManagedStopAuthority): void {
    const requested = authority === undefined ? undefined : this.validateAuthority(authority)
    const current = this.read()
    this.assertOwner(current, requested, false)
    if (requested && !current?.authority) {
      throw new Error('pty_ownership_transfer_admission_authority_unverifiable')
    }
    // Always flush again: an earlier rename may have succeeded before durability failed.
    this.write('open', requested)
  }

  private validateAuthority(value: unknown): OrcadManagedStopAuthority {
    const parsed = OrcadManagedStopAuthoritySchema.safeParse(value)
    if (
      !parsed.success ||
      parsed.data.runtimeId !== this.runtimeId ||
      parsed.data.profileRoot !== realpathSync(this.directory)
    ) {
      throw new Error('pty_ownership_transfer_admission_record_invalid')
    }
    return parsed.data
  }

  private assertOwner(
    current: AdmissionRecord | null,
    requested: OrcadManagedStopAuthority | undefined,
    allowNewTransaction: boolean
  ): void {
    if (current?.authority) {
      if (
        !requested ||
        (!sameOrcadManagedStopAuthority(current.authority, requested) &&
          !(allowNewTransaction && current.authority.profileId === requested.profileId))
      ) {
        throw new Error('pty_ownership_transfer_admission_authority_mismatch')
      }
    } else if (requested && current?.state === 'closed') {
      throw new Error('pty_ownership_transfer_admission_authority_unverifiable')
    }
  }

  private write(state: 'closed' | 'open', authority?: OrcadManagedStopAuthority): void {
    this.writeUnconfirmed = true
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileDurableSync(
      durableWriteTempPath(this.path),
      this.path,
      JSON.stringify({
        version: authority ? 2 : 1,
        runtimeId: this.runtimeId,
        state,
        ...(authority ? { authority } : {})
      }),
      0o600
    )
    // Admission evidence must not hide storage errors behind the general writer's best effort.
    bestEffortFsyncDirectorySync(this.directory)
    this.writeUnconfirmed = false
  }
}
