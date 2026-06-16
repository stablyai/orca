// Pure last-intent-wins guard for optimistic mutations (KTD6/R6). No React or
// react-native imports so it stays unit-testable under the node Vitest config —
// the hook holds the ref and the field via useRef/useState.

export type OptimisticSeqRef = { current: number }

// Bump the monotonic counter and return the sequence stamp for this write. The
// hook tags each in-flight mutation with the returned value.
export function nextSeq(ref: OptimisticSeqRef): number {
  ref.current += 1
  return ref.current
}

// A response is allowed to win only if its write is still the most recent intent;
// a slow earlier response (smaller seq) is stale and must be ignored.
export function isLatest(ref: OptimisticSeqRef, seq: number): boolean {
  return ref.current === seq
}

// A single optimistically-mutated field. `resolve` renders `optimistic ??
// authoritative`; on settle, only the latest write affects the rendered value —
// a stale (superseded) response neither commits nor reverts.
export type OptimisticField<T> = {
  // The sequence of the currently-shown optimistic value, or 0 when none.
  begin: (value: T) => number
  // Returns true when this seq was the latest and optimism was cleared.
  settleSuccess: (seq: number) => boolean
  // Returns true when this seq was the latest and its optimistic value was reverted.
  settleFailure: (seq: number) => boolean
  // Render value: optimistic when present, else the passed authoritative value.
  resolve: (authoritative: T) => T
  // Current optimistic value (undefined when none) — for read-only inspection.
  peek: () => T | undefined
}

// Factory holds the per-field sequence ref + optimistic value. Pure logic; the
// hook re-creates one per field and triggers re-renders via its own state.
export function createOptimisticField<T>(onChange?: () => void): OptimisticField<T> {
  const seqRef: OptimisticSeqRef = { current: 0 }
  let optimisticSeq = 0
  let optimisticValue: T | undefined

  const clear = (): void => {
    optimisticSeq = 0
    optimisticValue = undefined
    onChange?.()
  }

  return {
    begin(value: T): number {
      const seq = nextSeq(seqRef)
      optimisticSeq = seq
      optimisticValue = value
      onChange?.()
      return seq
    },
    settleSuccess(seq: number): boolean {
      // Only the latest write commits; a stale success leaves the newer intent shown.
      if (!isLatest(seqRef, seq) || optimisticSeq !== seq) {
        return false
      }
      clear()
      return true
    },
    settleFailure(seq: number): boolean {
      // Revert only when this failing write is still the value on screen; a stale
      // failure must not blow away a newer intent (last-intent-wins).
      if (!isLatest(seqRef, seq) || optimisticSeq !== seq) {
        return false
      }
      clear()
      return true
    },
    resolve(authoritative: T): T {
      return optimisticSeq !== 0 ? (optimisticValue as T) : authoritative
    },
    peek(): T | undefined {
      return optimisticSeq !== 0 ? optimisticValue : undefined
    }
  }
}
