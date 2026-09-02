// Why: shared between the runtime RPC server (createMobilePairingOffer) and the mobile IPC layer
// (getRuntimePairingUrl) so a failed pairing widen surfaces one consistent message. Kept in its own light
// module so the mobile IPC unit test can import the string without loading the full RPC/SSH module graph.
export const NETWORK_EXPOSURE_FAILED_GUIDANCE =
  'Could not expose the runtime to the network for pairing. The listener kept serving locally; retry, or choose an unused --port if the LAN bind was refused.'
