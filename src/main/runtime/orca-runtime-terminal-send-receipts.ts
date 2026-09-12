import { createHash } from 'node:crypto'
import type {
  TerminalSendOperationInFlight,
  TerminalSendOperationResult
} from './runtime-ownership-transfer-contracts'
import {
  TERMINAL_SEND_OPERATION_TTL_MS,
  TERMINAL_SEND_OPERATION_MAX_PER_PTY
} from './runtime-ownership-transfer-contracts'
import { OrcaRuntimeWithOwnershipTransferCanary } from './orca-runtime-ownership-transfer-canary'

export class OrcaRuntimeWithTerminalSendReceipts extends OrcaRuntimeWithOwnershipTransferCanary {
  protected terminalSendPayloadFingerprint(payload: string): string {
    return createHash('sha256').update(payload, 'utf8').digest('hex')
  }

  protected async writeTerminalSendWithReceipt(args: {
    ptyId: string
    incarnationId: string | null | undefined
    operationId: string | undefined
    payload: string
    write: () => Promise<void | Pick<TerminalSendOperationResult, 'prompt'>>
  }): Promise<TerminalSendOperationResult> {
    const { ptyId, incarnationId, operationId, payload, write } = args
    const bytesWritten = Buffer.byteLength(payload, 'utf8')
    if (!operationId || !incarnationId) {
      const delivery = await write()
      return copyTerminalSendResult({
        bytesWritten,
        ...(delivery?.prompt ? { prompt: delivery.prompt } : {})
      })
    }

    const payloadFingerprint = this.terminalSendPayloadFingerprint(payload)
    const recorded = this.readTerminalSendOperation(ptyId, incarnationId, operationId, payload)
    if (recorded) {
      return recorded
    }

    const inFlightOperations = this.terminalSendOperationsInFlightByPtyId.get(ptyId)
    const inFlight = inFlightOperations?.get(operationId)
    if (inFlight) {
      if (
        inFlight.incarnationId !== incarnationId ||
        inFlight.payloadFingerprint !== payloadFingerprint
      ) {
        throw new Error('terminal_send_operation_conflict')
      }
      return copyTerminalSendResult(await inFlight.promise)
    }

    this.ensureTerminalSendOperationCapacity(ptyId, operationId)
    const promise = Promise.resolve().then(async () => {
      const delivery = await write()
      return copyTerminalSendResult({
        bytesWritten,
        ...(delivery?.prompt ? { prompt: delivery.prompt } : {})
      })
    })
    const operations = inFlightOperations ?? new Map<string, TerminalSendOperationInFlight>()
    operations.set(operationId, Object.freeze({ incarnationId, payloadFingerprint, promise }))
    this.terminalSendOperationsInFlightByPtyId.set(ptyId, operations)
    try {
      const result = await promise
      this.rememberTerminalSendOperation(ptyId, incarnationId, operationId, payload, result)
      return copyTerminalSendResult(result)
    } finally {
      if (operations.get(operationId)?.promise === promise) {
        operations.delete(operationId)
      }
      if (operations.size === 0) {
        this.terminalSendOperationsInFlightByPtyId.delete(ptyId)
      }
    }
  }

  protected readTerminalSendOperation(
    ptyId: string,
    incarnationId: string | null | undefined,
    operationId: string | undefined,
    payload: string
  ): TerminalSendOperationResult | null {
    if (!operationId || !incarnationId) {
      return null
    }
    const operations = this.terminalSendOperationsByPtyId.get(ptyId)
    const existing = operations?.get(operationId)
    if (!existing) {
      return null
    }
    if (existing.expiresAt <= Date.now()) {
      operations?.delete(operationId)
      if (operations?.size === 0) {
        this.terminalSendOperationsByPtyId.delete(ptyId)
      }
      return null
    }
    if (
      existing.incarnationId !== incarnationId ||
      existing.payloadFingerprint !== this.terminalSendPayloadFingerprint(payload)
    ) {
      throw new Error('terminal_send_operation_conflict')
    }
    return copyTerminalSendResult(existing)
  }

  protected rememberTerminalSendOperation(
    ptyId: string,
    incarnationId: string | null | undefined,
    operationId: string | undefined,
    payload: string,
    result: TerminalSendOperationResult
  ): void {
    if (!operationId || !incarnationId) {
      return
    }
    const now = Date.now()
    const operations = this.terminalSendOperationsByPtyId.get(ptyId) ?? new Map()
    for (const [id, record] of operations) {
      if (record.expiresAt <= now) {
        operations.delete(id)
      }
    }
    // Capacity is checked before the PTY write by ensureTerminalSendOperationCapacity.
    operations.set(
      operationId,
      Object.freeze({
        incarnationId,
        payloadFingerprint: this.terminalSendPayloadFingerprint(payload),
        ...copyTerminalSendResult(result),
        expiresAt: now + TERMINAL_SEND_OPERATION_TTL_MS
      })
    )
    this.terminalSendOperationsByPtyId.set(ptyId, operations)
  }

  protected ensureTerminalSendOperationCapacity(
    ptyId: string,
    operationId: string | undefined
  ): void {
    if (!operationId) {
      return
    }
    const operations = this.terminalSendOperationsByPtyId.get(ptyId)
    const inFlightOperations = this.terminalSendOperationsInFlightByPtyId.get(ptyId)
    if (!operations && !inFlightOperations) {
      return
    }
    const now = Date.now()
    if (operations) {
      for (const [id, record] of operations) {
        if (record.expiresAt <= now) {
          operations.delete(id)
        }
      }
    }
    if (operations?.size === 0) {
      this.terminalSendOperationsByPtyId.delete(ptyId)
    }
    const completedCount = operations?.size ?? 0
    const inFlightCount = inFlightOperations?.size ?? 0
    if (completedCount + inFlightCount >= TERMINAL_SEND_OPERATION_MAX_PER_PTY) {
      throw new Error('terminal_send_operation_window_exhausted')
    }
  }
}

function copyTerminalSendResult(result: TerminalSendOperationResult): TerminalSendOperationResult {
  return {
    bytesWritten: result.bytesWritten,
    ...(result.prompt ? { prompt: { ...result.prompt, stages: [...result.prompt.stages] } } : {})
  }
}
