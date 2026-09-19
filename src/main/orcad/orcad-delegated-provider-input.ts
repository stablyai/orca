import { randomUUID } from 'node:crypto'
import type { PtyProviderOperationRetry } from '../providers/pty-provider-contract'
import type { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'
import type { DelegatedInputState } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-input-state'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../../shared/pty-ownership-transfer-destination-input'

type Operations = ReturnType<typeof createOrcadDelegatedPtyOperations>

/** One terminal's provider-facing write lane; retirement ends the caller's retry contract. */
export class OrcadDelegatedProviderInput {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private pendingBytes = 0
  whenIdle = (): Promise<void> => this.tail
  runControl = <T>(id: string, operation: () => Promise<T>): Promise<T> =>
    this.enqueue(id, 0, operation)

  constructor(
    private readonly options: {
      ptyId: string
      operations: Pick<
        Operations,
        'input' | 'settleInput' | 'retireInput' | 'recoverInputRetirement'
      >
      readInputs: () => DelegatedInputState | null
      isActive: () => boolean
      onError: (error: unknown) => void
      createInputId?: () => string
    }
  ) {}

  write = (id: string, data: string, retry?: PtyProviderOperationRetry): boolean => {
    try {
      void this.submit(id, data, retry).then(
        (applied) => {
          if (!applied) {
            this.report(new Error('orcad_delegated_input_unverifiable'))
          }
        },
        (error) => this.report(error)
      )
      return true
    } catch (error) {
      this.report(error)
      return false
    }
  }

  writeWithSettlement = async (
    id: string,
    data: string,
    retry?: PtyProviderOperationRetry
  ): Promise<boolean> => this.submit(id, data, retry)

  retireWriteOperation = async (id: string, operationId: string): Promise<boolean> =>
    this.enqueue(id, 0, async () => {
      const state = this.options.readInputs()
      const entry = state?.entries.find((entry) => entry.inputId === operationId)
      if (!state || !entry || entry.phase === 'attempted') {
        return false
      }
      if (state.retiring) {
        await this.options.operations.recoverInputRetirement(id)
        return true
      }
      await this.options.operations.settleInput(id, operationId, state.epoch)
      await this.retireSettled(id)
      return true
    })

  private submit(id: string, data: string, retry?: PtyProviderOperationRetry): Promise<boolean> {
    const inputId = retry?.operationId ?? this.options.createInputId?.() ?? randomUUID()
    if (!inputId || inputId.length > 256 || typeof data !== 'string') {
      throw new Error('orcad_delegated_input_invalid')
    }
    const callerRetires = retry !== undefined
    let settle!: (value: boolean) => void
    let fail!: (error: unknown) => void
    const settlement = new Promise<boolean>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    const queued = this.enqueue(id, Buffer.byteLength(data, 'utf8'), async () => {
      if (this.options.readInputs()?.retiring) {
        await this.options.operations.recoverInputRetirement(id)
      }
      const epoch = this.options.readInputs()?.epoch ?? 0
      const result = await this.options.operations.input(id, inputId, data, epoch)
      if (result.outcome !== 'applied') {
        return false
      }
      settle(true)
      if (!callerRetires) {
        // No caller retry ID exists, so successful delivery settles this generated attempt.
        try {
          await this.options.operations.settleInput(id, inputId, epoch)
          await this.retireSettled(id)
        } catch (error) {
          this.report(error)
        }
      }
      return true
    })
    void queued.then(settle, fail)
    return settlement
  }

  private async retireSettled(id: string): Promise<void> {
    const state = this.options.readInputs()
    if (state?.entries.length && state.entries.every((entry) => entry.phase === 'settled')) {
      await this.options.operations.retireInput(
        id,
        state.entries.map((entry) => entry.inputId),
        state.epoch
      )
    }
  }

  private enqueue<T>(id: string, bytes: number, operation: () => Promise<T>): Promise<T> {
    if (id !== this.options.ptyId || !this.options.isActive()) {
      throw new Error('orcad_delegated_input_unverifiable')
    }
    if (
      this.pending >= 256 ||
      this.pendingBytes + bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
    ) {
      throw new Error('orcad_delegated_input_queue_full')
    }
    this.pending++
    this.pendingBytes += bytes
    const result = this.tail
      .then(async () => {
        if (!this.options.isActive()) {
          throw new Error('orcad_delegated_input_unverifiable')
        }
        return operation()
      })
      .finally(() => {
        this.pending--
        this.pendingBytes -= bytes
      })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private report(error: unknown): void {
    try {
      this.options.onError(error)
    } catch {
      /* Diagnostics cannot change delivery evidence. */
    }
  }
}
