import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import {
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../shared/pty-write-settlement'

export type OrchestrationPointerWriteArgs = {
  ptyId: string
  data: string
  controller: RuntimePtyController | null | undefined
}

/**
 * Every orchestration pointer byte, including the Enter frame, settles through here. A throw from
 * the controller cannot prove no byte left, and collapsing it into a refusal is what cleared
 * durable mailbox reservations for writes that may already have been on the wire.
 */
export function writeOrchestrationPointerWithSettlement(
  args: OrchestrationPointerWriteArgs
): WriteSettlement | Promise<WriteSettlement> {
  const settledWrite = args.controller?.writeWithSettlement
  if (!settledWrite) {
    return writeRefused('provider_cannot_settle')
  }
  try {
    return settledWrite.call(args.controller, args.ptyId, args.data)
  } catch {
    // A partial write that then threw cannot prove the transport took nothing.
    return writeUnverifiable('provider_threw_after_handoff', true)
  }
}
