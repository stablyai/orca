export function createOrcadDelegatedExecutionRefresh(options: {
  isActive: () => boolean
  isReady: (finalOutputSeq: number) => boolean
  refresh: () => Promise<unknown>
  onError: (error: unknown) => void
  probeFinalOutputSeq?: () => Promise<number | null>
}) {
  let finalSeq: number | undefined
  let completed = false
  let stopped = false
  let pending: Promise<void> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  let probePending: Promise<void> | undefined
  const report = (error: unknown) => {
    try {
      options.onError(error)
    } catch {
      /* Diagnostics cannot strand exit recovery. */
    }
  }
  const wake = () => {
    if (
      stopped ||
      completed ||
      pending ||
      finalSeq === undefined ||
      !options.isActive() ||
      !options.isReady(finalSeq)
    ) {
      return
    }
    clearTimeout(retryTimer)
    retryTimer = undefined
    pending = Promise.resolve()
      .then(async () => {
        if (stopped || !options.isActive() || !options.isReady(finalSeq!)) {
          return
        }
        await options.refresh()
        if (!stopped && options.isActive()) {
          completed = true
        }
      })
      .catch((error) => {
        if (!stopped && options.isActive()) {
          report(error)
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            wake()
          }, 1000)
          retryTimer.unref?.()
        }
      })
      .finally(() => {
        pending = undefined
      })
  }
  const request = (seq: number) => {
    if (!Number.isSafeInteger(seq) || seq < 0 || (finalSeq !== undefined && finalSeq !== seq)) {
      report(new Error('orcad_delegated_exit_cursor_conflict'))
      return
    }
    finalSeq = seq
    clearTimeout(probeTimer)
    probeTimer = undefined
    wake()
  }
  const scheduleProbe = () => {
    if (
      !options.probeFinalOutputSeq ||
      stopped ||
      completed ||
      finalSeq !== undefined ||
      !options.isActive() ||
      probeTimer ||
      probePending
    ) {
      return
    }
    probeTimer = setTimeout(() => {
      probeTimer = undefined
      if (stopped || !options.isActive()) {
        return
      }
      probePending = Promise.resolve()
        .then(async () => {
          if (stopped || !options.isActive()) {
            return
          }
          const seq = await options.probeFinalOutputSeq!()
          if (!stopped && options.isActive() && seq !== null) {
            request(seq)
          }
        })
        .catch((error) => {
          if (!stopped && options.isActive()) {
            report(error)
          }
        })
        .finally(() => {
          probePending = undefined
          scheduleProbe()
        })
    }, 2000)
    probeTimer.unref?.()
  }
  scheduleProbe()
  return {
    request,
    wake,
    dispose: () => {
      stopped = true
      clearTimeout(retryTimer)
      clearTimeout(probeTimer)
      return Promise.all([pending, probePending]).then(() => undefined)
    }
  }
}
