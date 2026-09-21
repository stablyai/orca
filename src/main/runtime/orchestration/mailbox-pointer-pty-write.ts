import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from '../agent-session-pty-write-gate'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../shared/pty-write-settlement'

export type OrchestrationPointerWriteArgs = {
  ptyId: string
  data: string
  admissionByPtyId: Map<string, AgentSessionPtyWriteAdmittance>
  controller: RuntimePtyController | null | undefined
}

/**
 * Every orchestration pointer byte, including the Enter frame, settles through here. Split from
 * the lease gate on purpose: a throw before the controller is reached proves no byte left, while
 * a throw from the controller cannot, and collapsing the two is what cleared durable mailbox
 * reservations for writes that may already have been on the wire.
 */
export function writeOrchestrationPointerWithSettlement(
  args: OrchestrationPointerWriteArgs
): WriteSettlement | Promise<WriteSettlement> {
  const gated = admitOrchestrationPointerWrite(args)
  if (gated) {
    return gated
  }
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

/** Settles the write itself when the lease gate decides it; null means proceed to the provider. */
function admitOrchestrationPointerWrite(
  args: OrchestrationPointerWriteArgs
): WriteSettlement | null {
  const { ptyId, data, admissionByPtyId, controller } = args
  try {
    if (data === '\r') {
      const admitted = admissionByPtyId.get(ptyId)
      admissionByPtyId.delete(ptyId)
      if (admitted) {
        // Throws when the lease moved under the in-flight pointer, withholding the submit.
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        return null
      }
      // A denied bound lease must not receive a raw Enter, even when it did not follow a
      // pointer write. Keep unbound legacy terminals on the existing controller path.
      const admission = agentSessionPtyWriteGate.admit(ptyId)
      return !admission.admitted && agentSessionPtyWriteGate.boundSessionId(ptyId) !== null
        ? writeRefused('write_gate_denied')
        : null
    }
    const admission = agentSessionPtyWriteGate.admit(ptyId)
    if (!admission.admitted) {
      admissionByPtyId.delete(ptyId)
      if (agentSessionPtyWriteGate.boundSessionId(ptyId) !== null) {
        return writeRefused('write_gate_denied')
      }
      // Preserve the controller's own refusal reporting for internal deliveries.
      return controller?.write(ptyId, data)
        ? WRITE_ACCEPTED
        : writeRefused('provider_refused_write')
    }
    admissionByPtyId.set(ptyId, {
      sessionId: admission.sessionId,
      runtimeFence: admission.runtimeFence
    })
    return null
  } catch {
    // Every throw here happens before the controller is reached, so no byte can have left.
    return writeRefused('write_gate_denied')
  }
}
