import { OrcadManagedStopCancellationResultSchema } from '../../shared/orcad-managed-stop-cancellation'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { withStaleOrcadActivationRecoveryLock } from './orcad-activation-lock'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { sameOrcadActivationRecord } from './orcad-activation-transaction'
import { sameExactOrcadStopTransaction } from './orcad-completed-stop-receipt-store'
import { verifyRemoteOrcadCanceledStopReceipt } from './orcad-canceled-stop-receipt-store'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import type { SshConnection } from './ssh-connection'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export type OrcadManagedStopCancellationOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  runtimeId: string
  signal?: AbortSignal
  requestCancellation(request: OrcadManagedStopRequest): Promise<unknown>
}

export async function cancelInterruptedOrcadManagedStop(
  options: OrcadManagedStopCancellationOptions
) {
  const refuse = (reason: string) => ({
    outcome: 'refused' as const,
    verdict: 'unverifiable' as const,
    code: 'orcad_cancellation_recovery_unverifiable',
    reason
  })
  try {
    if (!options.runtimeId.trim()) {
      return refuse('Cancellation requires a pinned runtime identity.')
    }
    const original = await readOrcadActivationTransaction(options)
    if (!original) {
      return { outcome: 'none' as const }
    }
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      const preserve = (reason: string) => {
        lock.retain()
        return refuse(reason)
      }
      try {
        const transaction = await readOrcadActivationTransaction(options)
        if (
          !transaction ||
          !sameExactOrcadStopTransaction(transaction, original) ||
          transaction.operation !== 'decommission' ||
          transaction.schemaVersion !== 2 ||
          transaction.phase !== 'prepared' ||
          transaction.authority?.runtimeId !== options.runtimeId ||
          !transaction.instance
        ) {
          return preserve('The original prepared managed-stop transaction cannot be verified.')
        }
        const request = OrcadManagedStopRequestSchema.parse({
          schemaVersion: 1,
          version: transaction.activeVersion,
          authority: transaction.authority,
          instance: transaction.instance
        })
        const assertUnchanged = async () => {
          const current = await readOrcadActivationRecord(options)
          const pending = await readOrcadActivationTransaction(options)
          if (
            !pending ||
            !sameExactOrcadStopTransaction(pending, transaction) ||
            !sameOrcadActivationRecord(current, transaction.recordBefore) ||
            current.decommissioning
          ) {
            throw new Error('The pending stop or activation record changed during cancellation.')
          }
        }
        await assertUnchanged()
        const response = OrcadManagedStopCancellationResultSchema.parse(
          await options.requestCancellation(request)
        )
        if (
          response.outcome !== 'canceled' ||
          JSON.stringify(OrcadManagedStopRequestSchema.parse(response)) !== JSON.stringify(request)
        ) {
          return preserve('The original host did not acknowledge this exact cancellation.')
        }
        await verifyRemoteOrcadCanceledStopReceipt(options, request)
        await assertUnchanged()
        return {
          outcome: 'canceled' as const,
          transactionId: transaction.transactionId,
          activeVersion: transaction.activeVersion
        }
      } catch (error) {
        return preserve(error instanceof Error ? error.message : String(error))
      }
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending' as const,
        code: 'orcad_cancellation_lock_fresh',
        reason: 'The activation transaction is still owned or inside its recovery window.'
      }
    }
    return refuse(error instanceof Error ? error.message : String(error))
  }
}
