// Keep RPC/IPC pairing guidance consistent without importing their full module graph.
export const NETWORK_EXPOSURE_FAILED_GUIDANCE =
  'Could not expose the runtime to the network for pairing. The listener kept serving locally; retry, or choose an unused --port if the LAN bind was refused.'
