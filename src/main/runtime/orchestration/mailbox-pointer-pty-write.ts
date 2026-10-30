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

/** Settle every pointer byte and Enter here; a controller throw cannot prove no bytes left and must retain reservations. */
export function writeOrchestrationPointerWithSettlement(
  args: OrchestrationPointerWriteArgs
): WriteSettlement | Promise<WriteSettlement> {
  const settledWrite = args.controller?.writeWithSettlement
  if (!settledWrite) {
    return writeRefused('provider_cannot_settle')
  }
  try {
    // Pointer input tells the agent to read its mail.
    return settledWrite.call(args.controller, args.ptyId, args.data, 'orchestration')
  } catch {
    // A partial write that then threw cannot prove the transport took nothing.
    return writeUnverifiable('provider_threw_after_handoff', true)
  }
}
