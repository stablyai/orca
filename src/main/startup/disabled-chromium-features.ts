// Why: kept free of the electron import so real-Electron probes can launch a child with the exact shipped list.
export const DISABLED_CHROMIUM_FEATURES = [
  'FedCm',
  // Why: Electron ships no DirectSocketsDelegate, so the exposed constructors cannot egress but `new TCPSocket(...)`
  // trips a mojo ReportBadMessage that kills the guest renderer — a page-triggerable kill that pollutes crash telemetry.
  'DirectSockets',
  'DirectSocketsInSharedWorkers',
  'DirectSocketsInServiceWorkers'
] as const
