export type KiroUsageApi = {
  /** Starts a background `/usage` read; the value arrives over the rate-limit push. */
  refresh: (force?: boolean) => Promise<void>
}
