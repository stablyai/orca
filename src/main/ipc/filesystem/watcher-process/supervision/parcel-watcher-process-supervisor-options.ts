export type WatcherProcessSupervisorOptions = {
  entryPath?: string
  useInProcessVitestFallback?: boolean
  /** OS event delivery for this supervisor's child stalled (true) or recovered (false). */
  onDeliveryStallChange?: (stalled: boolean) => void
}
