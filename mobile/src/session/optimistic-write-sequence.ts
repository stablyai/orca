// Only the latest user intent may commit or revert optimism; stale responses must leave newer edits visible.

export type OptimisticSeqRef = { current: number }

export function nextSeq(ref: OptimisticSeqRef): number {
  ref.current += 1
  return ref.current
}

export function isLatest(ref: OptimisticSeqRef, seq: number): boolean {
  return ref.current === seq
}

export type OptimisticField<T> = {
  begin: (value: T) => number
  settleSuccess: (seq: number) => boolean
  settleFailure: (seq: number) => boolean
  resolve: (authoritative: T) => T
  peek: () => T | undefined
  reset: () => boolean
}

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
      if (!isLatest(seqRef, seq) || optimisticSeq !== seq) {
        return false
      }
      clear()
      return true
    },
    settleFailure(seq: number): boolean {
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
    },
    reset(): boolean {
      if (optimisticSeq === 0) {
        return false
      }
      clear()
      return true
    }
  }
}
