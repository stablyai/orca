export const OMP_RPC_PROTOCOL_VERSION = 2
export const OMP_RPC_MAX_FRAME_BYTES = 1_048_576
export const OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES = 67_108_864
export const OMP_RPC_MAX_CHUNK_PAYLOAD_BYTES = 262_144
export const OMP_RPC_MAX_MESSAGE_PAGE_LIMIT = 256
export const OMP_RPC_MAX_MESSAGE_CURSOR_CHARS = 2_048

/** Response deadline for a correlated RPC request (XLR-016, cross-lab review).
 *  A child that stays alive and accepts stdin but stops answering used to hang
 *  `getState` forever, which made every wait built on it unbounded — the 10s
 *  settle wait, the release that follows it, and any later acquire queued
 *  behind that release. Matched to the settle deadline so a stuck read fails
 *  the settle in one interval and reaches the exit proof instead of stranding
 *  the claim. */
export const OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS = 10_000
