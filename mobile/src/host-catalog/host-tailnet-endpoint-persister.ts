// Serialize writes and mark an endpoint recorded only after it lands, so a failed write retries on the next report.
export function createTailnetEndpointPersister(
  initial: string | undefined,
  write: (endpoint: string) => Promise<void>
): (endpoint: string) => void {
  let recorded = initial
  let desired = initial
  let persisting = false

  const drain = async (): Promise<void> => {
    if (persisting) {
      return
    }
    persisting = true
    try {
      while (desired !== undefined && desired !== recorded) {
        const target = desired
        try {
          await write(target)
        } catch {
          return
        }
        recorded = target
      }
    } finally {
      persisting = false
    }
  }

  return (endpoint) => {
    desired = endpoint
    void drain()
  }
}
