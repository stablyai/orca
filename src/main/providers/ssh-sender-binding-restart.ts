import { ORCHESTRATION_SENDER_CAPABILITY_ENV } from '../../shared/orchestration-sender-capability'
import type { SshSenderBindingShutdownReceipt } from '../../shared/orchestration-sender-capability'
import type { PtySpawnOptions } from './types'

export const SSH_SENDER_BINDING_RESTART_FAILED_ERROR = 'SSH_SENDER_BINDING_RESTART_FAILED'

type RestartSshPtyInput = {
  opts: PtySpawnOptions
  relaySessionId: string
  pendingByRelayPtyId: Map<string, string>
  shutdown: () => Promise<unknown>
}

function parseShutdownReceipt(value: unknown): SshSenderBindingShutdownReceipt | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const receipt = value as Partial<SshSenderBindingShutdownReceipt>
  return typeof receipt.senderBindingGeneration === 'string' &&
    (receipt.senderBindingState === 'absent' || receipt.senderBindingState === 'exited')
    ? {
        senderBindingGeneration: receipt.senderBindingGeneration,
        senderBindingState: receipt.senderBindingState
      }
    : null
}

function hasSenderBindingReceiptFields(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('senderBindingGeneration' in value || 'senderBindingState' in value)
  )
}

export function requireSshSenderBindingGeneration(opts: PtySpawnOptions): string | null {
  if (!opts.restartExistingSessionForSenderBinding) {
    return null
  }
  const capability = opts.env?.[ORCHESTRATION_SENDER_CAPABILITY_ENV]
  const generation = opts.senderBindingGeneration
  if (!capability || !generation) {
    throw new Error(`${SSH_SENDER_BINDING_RESTART_FAILED_ERROR}: missing capability generation`)
  }
  return generation
}

export async function restartSshPtyForSenderBinding({
  opts,
  relaySessionId,
  pendingByRelayPtyId,
  shutdown
}: RestartSshPtyInput): Promise<boolean> {
  const generation = requireSshSenderBindingGeneration(opts)
  if (!generation) {
    return false
  }

  pendingByRelayPtyId.set(relaySessionId, generation)
  let shutdownResult: unknown
  try {
    shutdownResult = await shutdown()
  } catch (error) {
    pendingByRelayPtyId.delete(relaySessionId)
    // Why: an untagged late exit could otherwise revoke the fresh generation.
    throw new Error(
      `${SSH_SENDER_BINDING_RESTART_FAILED_ERROR}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const receipt = parseShutdownReceipt(shutdownResult)
  if (
    hasSenderBindingReceiptFields(shutdownResult) &&
    receipt?.senderBindingGeneration !== generation
  ) {
    pendingByRelayPtyId.delete(relaySessionId)
    throw new Error(`${SSH_SENDER_BINDING_RESTART_FAILED_ERROR}: shutdown receipt mismatch`)
  }
  if (pendingByRelayPtyId.has(relaySessionId)) {
    if (
      receipt?.senderBindingGeneration === generation &&
      receipt.senderBindingState === 'absent'
    ) {
      pendingByRelayPtyId.delete(relaySessionId)
      return true
    }
    pendingByRelayPtyId.delete(relaySessionId)
    throw new Error(`${SSH_SENDER_BINDING_RESTART_FAILED_ERROR}: old exit not observed`)
  }
  return true
}
