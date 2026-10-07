/** True when `work` settles (either way) within `deadlineMs`; false at the deadline. Never rejects. */
export function settlesWithin(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), deadlineMs)
    timer.unref?.()
    const settle = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    void work.then(settle, settle)
  })
}
