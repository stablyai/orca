import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/profile-state-writer-errors'

/** Keep runtime fakes on the same reserved, durable-before-ack contract as Store. */
export function withDurableRuntimeStore<
  T extends {
    flushOrThrow?: () => void
    flushPendingOrThrowAsync?: (options?: { drainToStableGeneration?: boolean }) => Promise<void>
  }
>(store: T) {
  let pending = Promise.resolve()
  return Object.assign(store, {
    runDurableMutation<Value>(mutate: () => DurableProfileStateMutation<Value>): Promise<Value> {
      const write = pending.then(async () => {
        const mutation = mutate()
        if (mutation.persist === false) {
          return mutation.value
        }
        try {
          if (store.flushPendingOrThrowAsync) {
            await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
          } else {
            store.flushOrThrow?.()
          }
        } catch (error) {
          if (profileStateWriterFailureOutcome(error) !== 'indeterminate') {
            mutation.rollback?.()
          }
          throw error
        }
        return mutation.value
      })
      pending = write.then(
        () => {},
        () => {}
      )
      return write
    }
  })
}
