export async function removeHostWithDurableCredentialCleanup(args: {
  hostId: string
  beginRemoval: () => number
  currentEpoch: () => number
  restorePublication: () => void
  scheduleCleanup: (
    hostId: string,
    deleteCredential: (hostId: string) => Promise<void>
  ) => Promise<boolean>
  deleteCredentials: (hostId: string) => Promise<void>
  removeMetadata: () => Promise<void>
  removeOverlay: () => Promise<void>
}): Promise<void> {
  const removalEpoch = args.beginRemoval()
  let resolveMetadataCommit!: () => void
  let rejectMetadataCommit!: (error: unknown) => void
  const metadataCommitted = new Promise<void>((resolve, reject) => {
    resolveMetadataCommit = resolve
    rejectMetadataCommit = reject
  })
  // Why: cleanup intent must survive a crash before base-host deletion, while
  // the native delete waits so a failed metadata write cannot strand the host.
  void metadataCommitted.catch(() => {})
  let cleanupIntentDurable = false
  try {
    cleanupIntentDurable = await args.scheduleCleanup(args.hostId, async (hostId) => {
      await metadataCommitted
      if (args.currentEpoch() === removalEpoch) {
        await args.deleteCredentials(hostId)
      }
    })
  } catch {}
  if (!cleanupIntentDurable) {
    const error = new Error('host credential cleanup intent was not durable')
    rejectMetadataCommit(error)
    if (args.currentEpoch() === removalEpoch) {
      args.restorePublication()
    }
    throw error
  }
  try {
    await args.removeMetadata()
    resolveMetadataCommit()
  } catch (error) {
    rejectMetadataCommit(error)
    // Why: a failed metadata removal keeps the host authoritative; release the
    // transient fence so normal existing-host work may retry.
    if (args.currentEpoch() === removalEpoch) {
      args.restorePublication()
    }
    throw error
  }
  // Why: a retained or late overlay cannot resurrect a missing legacy base,
  // so native overlay stalls must not hold removal or the global host queue.
  void args.removeOverlay().catch(() => {})
}
