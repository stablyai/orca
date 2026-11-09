/** How a provider-held screen should be fetched when runtime bytes are absent. */
export type RuntimeProviderSnapshotReadOptions = {
  /** Internal observers need the host stream without waiting on a renderer. */
  streamOnly?: boolean
  timeoutMs?: number
  retireOnTimeout?: boolean
  visibleScreenOnly?: boolean
}
