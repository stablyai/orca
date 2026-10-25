import {
  WRITE_ACCEPTED,
  writeRefused,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

/** Adapt test doubles without weakening the production requirement for explicit settled writes. */
export function stubWriteSettlement(accepted: boolean): WriteSettlement {
  return accepted ? WRITE_ACCEPTED : writeRefused('provider_refused_write')
}

export function settledWriteStub(
  write: (id: string, data: string) => boolean | void = () => true
): (id: string, data: string) => Promise<WriteSettlement> {
  return async (id, data) => stubWriteSettlement(write(id, data) !== false)
}
