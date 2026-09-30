import {
  WRITE_ACCEPTED,
  writeRefused,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

/**
 * Test doubles have to settle exactly like a real provider. Loosening
 * `writeWithSettlement`'s type so a boolean fake keeps compiling is what let the production
 * controller ship without a settled writer at all, so fakes adapt through here instead.
 */
export function stubWriteSettlement(accepted: boolean): WriteSettlement {
  return accepted ? WRITE_ACCEPTED : writeRefused('provider_refused_write')
}

/** Wraps a double's fire-and-forget `write` as the settled writer the contract demands. */
export function settledWriteStub(
  write: (id: string, data: string) => boolean | void = () => true
): (id: string, data: string) => Promise<WriteSettlement> {
  return async (id, data) => stubWriteSettlement(write(id, data) !== false)
}
