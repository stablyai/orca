import type { OfficeMethodResult } from '../../shared/office-preview-contracts'
import { officeFailure } from '../../shared/office-preview-contracts'
import type { OfficeRpcMethod } from '../../shared/office-preview-rpc'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

/**
 * Office work on an SSH host, forwarded to the relay's `OfficeHandler`.
 *
 * `method_not_found` is `OFFICE_HOST_UPDATE_REQUIRED` even though the relay is bundle-hash-locked
 * to its client: the lock makes the mismatch impossible in a healthy session, not unobservable in
 * a broken one, and a preview that says "update" beats one that says nothing.
 *
 * Every other transport error is `OFFICE_HOST_UNREACHABLE`, never a claim about the document or a
 * watch process. Loss of contact is `unverifiable` — see docs/reference/ssh-execution-boundary.md.
 */
export async function requestSshOffice(
  mux: SshChannelMultiplexer,
  method: OfficeRpcMethod,
  params: Record<string, unknown> | undefined
): Promise<OfficeMethodResult> {
  try {
    return (await mux.request(method, params)) as OfficeMethodResult
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return officeFailure('OFFICE_HOST_UPDATE_REQUIRED')
    }
    return officeFailure(
      'OFFICE_HOST_UNREACHABLE',
      error instanceof Error ? error.message : undefined
    )
  }
}
