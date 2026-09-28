import { normalizeWslDaemonRecovery } from '../../../shared/wsl-daemon-recovery'
import {
  normalizeWslPtyConsumerRecovery,
  type WslPtyRecoveryRecord
} from '../../../shared/wsl-pty-consumer-recovery'
import {
  wslPtyOwnerLeaseSecretSlot,
  type ProtectedSecretPersistence
} from '../../protected-secret-persistence'
import { isLegacySshPtyOwnerLease } from '../leasing-ssh-ptys/secret-validation'

export function decryptWslConsumerRecoveries(
  value: unknown,
  secrets: ProtectedSecretPersistence
): WslPtyRecoveryRecord[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((raw: unknown): WslPtyRecoveryRecord[] => {
    if (raw && typeof raw === 'object' && 'kind' in raw) {
      const daemon = normalizeWslDaemonRecovery(raw)
      return daemon ? [daemon] : []
    }
    const record = normalizeWslPtyConsumerRecovery(raw, true)
    if (!record) {
      return []
    }
    const slot = wslPtyOwnerLeaseSecretSlot(record)
    const decrypted = secrets.decryptWithStatus(slot, record.ownerLease, isLegacySshPtyOwnerLease)
    const normalized =
      decrypted.status === 'unavailable' || (decrypted.status === 'failed' && !decrypted.plaintext)
        ? record
        : normalizeWslPtyConsumerRecovery({ ...record, ownerLease: decrypted.plaintext })
    if (!normalized) {
      secrets.removeRetainedBlob(slot)
    }
    return normalized ? [normalized] : []
  })
}
