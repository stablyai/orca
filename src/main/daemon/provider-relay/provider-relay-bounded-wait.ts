/** Waits for `work`, but never longer than `ms`: a disk that never answers must not hold shutdown. */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  ])
  clearTimeout(timer)
}
