export type StructuredAgentSessionStartReadiness = {
  wait: (budgetMs?: number) => Promise<'ready' | 'ended' | 'timeout'>
}

export async function waitForStructuredAgentSessionStart(
  ready: Promise<'ready' | 'ended'>,
  budgetMs?: number
): Promise<'ready' | 'ended' | 'timeout'> {
  if (budgetMs === undefined) {
    return ready
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, budgetMs))
    timer.unref?.()
  })
  try {
    return await Promise.race([ready, timeout])
  } finally {
    clearTimeout(timer)
  }
}
