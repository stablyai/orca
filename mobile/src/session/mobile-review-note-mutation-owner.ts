export function createReviewNotesBaseline() {
  let resolve: (available: boolean) => void = () => {}
  const promise = new Promise<boolean>((settle) => {
    resolve = settle
  })
  return { promise, resolve, settled: false }
}

export function createMobileReviewNoteMutationOwner() {
  return {
    active: true,
    revision: 0,
    pending: 0,
    loadRevision: 0,
    tail: Promise.resolve(),
    baselineLoaded: false,
    baseline: createReviewNotesBaseline()
  }
}

export function enqueueMobileReviewNoteMutation<T>(
  owner: ReturnType<typeof createMobileReviewNoteMutationOwner>,
  mutate: () => Promise<T>,
  inactive: T,
  setBusy: (busy: boolean) => void,
  unavailable: () => void
): Promise<T> {
  owner.revision += 1
  owner.pending += 1
  if (owner.active) {
    setBusy(true)
  }
  const operation = owner.tail.then(async () => {
    const available = owner.baselineLoaded || (await owner.baseline.promise)
    if (!owner.active) {
      return inactive
    }
    if (!available) {
      unavailable()
      return inactive
    }
    return mutate()
  })
  owner.tail = operation.then(
    () => undefined,
    () => undefined
  )
  return operation.finally(() => {
    owner.pending -= 1
    owner.revision += 1
    if (owner.active && owner.pending === 0) {
      setBusy(false)
    }
  })
}
