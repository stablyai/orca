const pending = new Map<Int32Array, ReadonlySet<string>>()

/** Shared with the journal writer; revocation and publication contend on the same cell. */
export function holdAgentSessionPublicationFence(keys: readonly string[]): {
  fence: Int32Array
  release: () => void
} {
  const fence = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(fence, 0, 1)
  pending.set(fence, new Set(keys))
  return {
    fence,
    release: () => {
      pending.delete(fence)
    }
  }
}

/** A concurrent authority change cancels pending opens, never an already committed opening. */
export function revokeAgentSessionPublicationFences(keys: readonly string[]): void {
  for (const [fence, held] of pending) {
    if (keys.some((key) => held.has(key))) {
      Atomics.compareExchange(fence, 0, 1, 0)
    }
  }
}

/** Called in the writing transaction immediately before publishing its visibility rows. */
export function commitAgentSessionPublicationFence(fence: Int32Array | undefined): void {
  if (fence && Atomics.compareExchange(fence, 0, 1, 2) !== 1) {
    throw new Error('bot_link_target_changed')
  }
}
