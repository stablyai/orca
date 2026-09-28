import {
  normalizeWslDaemonRecovery,
  sameWslDaemonEndpoint,
  type WslDaemonIncarnation,
  type WslDaemonRecovery
} from '../../../shared/wsl-daemon-recovery'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { WslPtyOwner } from '../../../shared/wsl-pty-id'
import {
  normalizeWslPtyConsumerRecovery,
  isWslDaemonRecovery,
  wslPtyOwnerKey,
  type WslPtyConsumerRecovery
} from '../../../shared/wsl-pty-consumer-recovery'
import { wslPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import { runRelayLeaseDurableMutation } from './relay-lease-durable-mutation'

const context = Symbol('WslConsumerRecoveryOperations')
type Context = { runtime: StoreRuntimeState; barriers: WriteFlushBarrierOperations }

export class WslConsumerRecoveryOperations {
  readonly [context]: Context

  constructor(runtime: StoreRuntimeState, barriers: WriteFlushBarrierOperations) {
    this[context] = { runtime, barriers }
  }

  getWslPtyConsumerRecovery(owner: WslPtyOwner): WslPtyConsumerRecovery | null {
    const { runtime } = this[context]
    const key = wslPtyOwnerKey(owner)
    const record = runtime.state.wslPtyConsumerRecoveries?.find(
      (row) => wslPtyOwnerKey(row) === key
    )
    if (!record || isWslDaemonRecovery(record)) {
      return null
    }
    if (runtime.protectedSecrets.isSealed(wslPtyOwnerLeaseSecretSlot(owner), record.ownerLease)) {
      throw new Error('WSL terminal owner lease is unavailable while profile secrets are locked')
    }
    return structuredClone(record)
  }

  getWslDaemonRecovery(owner: WslPtyOwner): WslDaemonRecovery | null {
    const record = this[context].runtime.state.wslPtyConsumerRecoveries?.find(
      (row) => wslPtyOwnerKey(row) === wslPtyOwnerKey(owner) && isWslDaemonRecovery(row)
    )
    return record && isWslDaemonRecovery(record) ? structuredClone(record) : null
  }

  listWslDaemonRecoveries(): WslDaemonRecovery[] {
    return structuredClone(
      (this[context].runtime.state.wslPtyConsumerRecoveries ?? []).filter(isWslDaemonRecovery)
    )
  }

  async upsertWslDaemonRecovery(
    record: WslDaemonRecovery,
    expectedIncarnation?: WslDaemonIncarnation | null
  ): Promise<void> {
    const normalized = normalizeWslDaemonRecovery(record)
    if (!normalized) {
      throw new Error('Invalid WSL daemon recovery record')
    }
    const { runtime, barriers } = this[context]
    const key = wslPtyOwnerKey(normalized)
    const refusal = await runRelayLeaseDurableMutation<Error | undefined>(
      runtime,
      barriers,
      'wslPtyConsumerRecoveries',
      () => {
        const previous = runtime.state.wslPtyConsumerRecoveries
        const rows = previous ?? []
        if (rows.some((row) => wslPtyOwnerKey(row) === key && !isWslDaemonRecovery(row))) {
          return {
            value: new Error('WSL terminal identity already belongs to a relay consumer'),
            persist: false
          }
        }
        const current = rows.find((row) => wslPtyOwnerKey(row) === key)
        if (current && isWslDaemonRecovery(current)) {
          if (!sameWslDaemonEndpoint(current.endpoint, normalized.endpoint)) {
            return { value: new Error('WSL daemon owner identity cannot change'), persist: false }
          }
          if (JSON.stringify(current.incarnation) === JSON.stringify(normalized.incarnation)) {
            return { value: undefined, persist: false }
          }
          if (
            !normalized.incarnation ||
            expectedIncarnation === undefined ||
            JSON.stringify(current.incarnation ?? null) !== JSON.stringify(expectedIncarnation)
          ) {
            return { value: new Error('WSL daemon incarnation admission changed'), persist: false }
          }
        } else if (expectedIncarnation) {
          return {
            value: new Error('WSL daemon incarnation admission disappeared'),
            persist: false
          }
        }
        runtime.state.wslPtyConsumerRecoveries = [
          ...rows.filter((row) => wslPtyOwnerKey(row) !== key),
          normalized
        ]
        return {
          value: undefined,
          rollback: () => {
            runtime.state.wslPtyConsumerRecoveries = previous
          }
        }
      }
    )
    if (refusal) {
      throw refusal
    }
  }

  async upsertWslPtyConsumerRecovery(record: WslPtyConsumerRecovery): Promise<void> {
    const normalized = normalizeWslPtyConsumerRecovery(record)
    if (!normalized) {
      throw new Error('Invalid WSL terminal consumer recovery record')
    }
    const { runtime, barriers } = this[context]
    const key = wslPtyOwnerKey(normalized)
    const refusal = await runRelayLeaseDurableMutation<Error | undefined>(
      runtime,
      barriers,
      'wslPtyConsumerRecoveries',
      () => {
        if (
          runtime.state.wslPtyConsumerRecoveries?.some(
            (row) => wslPtyOwnerKey(row) === key && isWslDaemonRecovery(row)
          )
        ) {
          return {
            value: new Error('WSL terminal identity already belongs to a daemon'),
            persist: false
          }
        }
        runtime.state.wslPtyConsumerRecoveries = [
          ...(runtime.state.wslPtyConsumerRecoveries ?? []).filter(
            (row) => wslPtyOwnerKey(row) !== key
          ),
          normalized
        ]
        return { value: undefined }
      }
    )
    if (refusal) {
      throw refusal
    }
  }

  async removeWslPtyConsumerRecovery(
    owner: WslPtyOwner,
    expectedClientInstanceId: string
  ): Promise<void> {
    const { runtime, barriers } = this[context]
    const key = wslPtyOwnerKey(owner)
    await runRelayLeaseDurableMutation(runtime, barriers, 'wslPtyConsumerRecoveries', () => {
      const records = runtime.state.wslPtyConsumerRecoveries ?? []
      const current = records.find((row) => wslPtyOwnerKey(row) === key)
      if (
        current &&
        (isWslDaemonRecovery(current) || current.clientInstanceId !== expectedClientInstanceId)
      ) {
        return { value: undefined, persist: false }
      }
      runtime.state.wslPtyConsumerRecoveries = records.filter((row) => wslPtyOwnerKey(row) !== key)
      return { value: undefined }
    })
    if (!runtime.state.wslPtyConsumerRecoveries?.some((row) => wslPtyOwnerKey(row) === key)) {
      runtime.protectedSecrets.removeRetainedBlob(wslPtyOwnerLeaseSecretSlot(owner))
    }
  }
}

export function installWslConsumerRecoveryOperationsContext(
  target: WslConsumerRecoveryOperations,
  source: WslConsumerRecoveryOperations
): void {
  Object.defineProperty(target, context, { value: source[context] })
}
