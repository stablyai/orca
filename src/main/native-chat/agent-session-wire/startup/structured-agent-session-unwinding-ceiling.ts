/** Settles once the start's own ceiling passes on its clock; never, if `unwinding` ends first. The
 *  ceiling's timer is re-armed, not a new deadline: a cut start keeps the limit it began with. */
export function holdUnwindingStartCeiling(args: {
  due: number
  now: () => number
  unwinding: Promise<unknown>
}): Promise<void> {
  const passed = Promise.withResolvers<void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let ended = false
  const arm = (): void => {
    if (ended) {
      return
    }
    const left = args.due - args.now()
    if (left <= 0) {
      passed.resolve()
      return
    }
    // The clock skips sleep, so a wake re-checks rather than trusting the timer.
    timer = setTimeout(arm, left)
    timer.unref?.()
  }
  const end = (): void => {
    ended = true
    if (timer) {
      clearTimeout(timer)
    }
  }
  void args.unwinding.then(end, end)
  arm()
  return passed.promise
}
