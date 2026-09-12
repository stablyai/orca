import {
  WRITE_ACCEPTED,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

export async function settleOwnershipTransferWrite(
  write: () => Promise<boolean>
): Promise<WriteSettlement> {
  try {
    return (await write()) ? WRITE_ACCEPTED : writeUnverifiable('transport_settlement_lost', true)
  } catch {
    // The durable source may have applied input before its acknowledgement was lost.
    return writeUnverifiable('provider_threw_after_handoff', true)
  }
}
