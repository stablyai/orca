import { ipcMain } from 'electron'
import {
  RuntimeEnvironmentReconciliationRequestSchema,
  type RuntimeEnvironmentReconciliationResult
} from '../../shared/runtime-environment-reconciliation-request'
import { RuntimeEnvironmentReconciliationRecordSchema } from '../../shared/runtime-environment-reconciliation-record'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { prepareVerifiedRuntimeEnvironmentReconciliation } from '../runtime/runtime-environment-reconciliation-verification'
import {
  cancelRuntimeEnvironmentReconciliation,
  transitionRuntimeEnvironmentReconciliationCatalog
} from '../runtime/runtime-environment-reconciliation-coordinator'

export function registerRuntimeEnvironmentReconciliationHandlers(options: {
  getUserDataPath: () => string
  retireControlTransport: (environmentId: string) => void
}): void {
  ipcMain.handle(
    'runtimeEnvironments:reconcile',
    async (event, input: unknown): Promise<RuntimeEnvironmentReconciliationResult> => {
      const args = RuntimeEnvironmentReconciliationRequestSchema.parse(input)
      if (
        (args.action === 'prepare' || args.action === 'activate') &&
        !isPtyOwnershipTransferMutationEnabled()
      ) {
        throw new Error('Host reconciliation requires the experimental ownership-transfer gate.')
      }
      const controller = new AbortController()
      const cancel = () => controller.abort(new Error('runtime_reconciliation_caller_destroyed'))
      event.sender.once('destroyed', cancel)
      try {
        if (event.sender.isDestroyed()) {
          cancel()
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
        signal.throwIfAborted()
        const userDataPath = options.getUserDataPath()
        if (args.action === 'cancel') {
          await cancelRuntimeEnvironmentReconciliation(userDataPath, { ...args, signal })
          return { record: null }
        }
        const record =
          args.action === 'prepare'
            ? await prepareVerifiedRuntimeEnvironmentReconciliation(userDataPath, {
                selectors: args.environmentIds,
                canonicalEnvironmentId: args.canonicalEnvironmentId,
                requestId: args.requestId,
                signal
              })
            : await transitionRuntimeEnvironmentReconciliationCatalog(
                userDataPath,
                {
                  environmentId: args.environmentId,
                  requestId: args.requestId,
                  active: args.action === 'activate',
                  signal
                },
                options.retireControlTransport
              )
        return { record: RuntimeEnvironmentReconciliationRecordSchema.parse(record) }
      } finally {
        event.sender.removeListener('destroyed', cancel)
      }
    }
  )
}
