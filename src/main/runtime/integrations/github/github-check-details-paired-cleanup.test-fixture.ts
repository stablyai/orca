type PairedCheckCleanup = {
  closeClient: () => void
  drain: () => Promise<void>
  closeChildren: () => void | Promise<void>
  stopServer: () => Promise<void>
  removeDirectory: () => void
}

async function stopWithinDeadline(stop: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(stop),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Paired check server stop timed out')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function withPairedCheckDetailsCleanup(
  actions: PairedCheckCleanup,
  run: () => Promise<void>,
  stopTimeoutMs = 2_000
): Promise<void> {
  let failure: { error: unknown } | undefined
  const attempt = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      failure ??= { error }
    }
  }
  try {
    await attempt(run)
  } finally {
    try {
      await attempt(actions.closeClient)
      await attempt(actions.drain)
    } finally {
      try {
        await attempt(actions.closeChildren)
      } finally {
        try {
          await attempt(() => stopWithinDeadline(actions.stopServer, stopTimeoutMs))
        } finally {
          await attempt(actions.removeDirectory)
        }
      }
    }
  }
  if (failure) {
    throw failure.error
  }
}
