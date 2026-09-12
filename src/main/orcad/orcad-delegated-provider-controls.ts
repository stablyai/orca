import { randomUUID } from 'node:crypto'
import type { IPtyProvider, PtyProviderOperationRetry } from '../providers/pty-provider-contract'
import type { PtyOwnershipTransferControl } from '../../shared/pty-ownership-transfer-control-wire'
import type { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import type { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'

export class OrcadDelegatedProviderControls {
  constructor(
    private readonly options: {
      incarnationId: string
      input: Pick<OrcadDelegatedProviderInput, 'runControl'>
      operations: Pick<ReturnType<typeof createOrcadDelegatedPtyOperations>, 'control'>
      onError: (error: unknown) => void
    }
  ) {}

  resize = (id: string, cols: number, rows: number, retry?: PtyProviderOperationRetry): void => {
    void this.control(id, { kind: 'resize', cols, rows }, retry).catch((error) => {
      try {
        this.options.onError(error)
      } catch {
        /* Keep fire-and-forget failures contained. */
      }
    })
  }

  sendSignal = (id: string, signal: string, retry?: PtyProviderOperationRetry): Promise<void> =>
    this.control(id, { kind: 'sendSignal', signal }, retry)

  clearBuffer = (id: string, retry?: PtyProviderOperationRetry): Promise<void> =>
    this.control(id, { kind: 'clearBuffer' }, retry)

  shutdown: IPtyProvider['shutdown'] = async (id, options) => {
    if (
      (options.expectedIncarnationId !== undefined &&
        options.expectedIncarnationId !== this.options.incarnationId) ||
      options.expectedOwnerClientInstanceId !== undefined ||
      options.keepHistory
    ) {
      throw new Error('orcad_delegated_shutdown_authority_unsupported')
    }
    await this.control(
      id,
      { kind: 'shutdown', immediate: options.immediate ?? false },
      options.operationId === undefined ? undefined : { operationId: options.operationId },
      options.deadlineMs
    )
  }

  private async control(
    id: string,
    control: PtyOwnershipTransferControl,
    retry?: PtyProviderOperationRetry,
    deadlineMs?: number
  ): Promise<void> {
    const operationId = retry?.operationId ?? randomUUID()
    const captured = { ...control }
    await this.options.input.runControl(id, async () => {
      const timeoutMs = deadlineMs === undefined ? undefined : deadlineMs - Date.now()
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new Error('orcad_delegated_control_deadline_expired')
      }
      const result = await this.options.operations.control(id, operationId, captured, timeoutMs)
      if (result.outcome !== 'applied') {
        throw new Error('orcad_delegated_control_unverifiable')
      }
    })
  }
}
