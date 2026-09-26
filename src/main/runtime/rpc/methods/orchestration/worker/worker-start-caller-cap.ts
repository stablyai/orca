/**
 * worker-start for a caller whose shell tool kills a command at a fixed limit: a chat's agent runs
 * every command under one. Killed, the caller gets nothing, not even the Dispatch id, and may start
 * a duplicate. So the start returns inside that limit with the worker's durable state, `starting`,
 * and keeps running in the host: it settles the worker ready, unknown or failed exactly as it
 * would have, for worker-show to report.
 */

const CAPPED = Symbol('capped')

export async function settleWithinCallerCap(
  start: Promise<unknown>,
  deadline: number | undefined,
  inProgressReceipt: () => unknown
): Promise<unknown> {
  if (deadline === undefined) {
    return start
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const capped = new Promise<typeof CAPPED>((resolve) => {
    timer = setTimeout(() => resolve(CAPPED), Math.max(0, deadline - Date.now()))
  })
  try {
    const first = await Promise.race([start, capped])
    if (first !== CAPPED) {
      return first
    }
  } finally {
    clearTimeout(timer)
  }
  start.catch((error: unknown) => {
    console.warn('[orchestration] a capped worker-start failed after returning', error)
  })
  return inProgressReceipt()
}
