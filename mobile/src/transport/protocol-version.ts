// Why: declares the mobile's pairing protocol version and the minimum
// desktop version it can talk to. Duplicates the desktop's
// `src/shared/protocol-version.ts` because Metro/Expo doesn't resolve
// outside `mobile/`. Manual sync is acceptable — these constants are
// expected to bump less than once a quarter.
//
// Bump MOBILE_PROTOCOL_VERSION when:
//   - You change the meaning of an RPC mobile sends.
//   - You stop relying on a desktop-side feature in a way old desktops
//     would notice.
// Do NOT bump for:
//   - Adding new optional fields to outbound requests.
//   - Reading new optional fields on incoming responses.
//
// Bump MIN_COMPATIBLE_DESKTOP_VERSION when mobile starts relying on a
// desktop feature added at a specific desktop protocol version. This
// triggers a hard-block screen for users paired to older desktops.

export const MOBILE_PROTOCOL_VERSION = 1
export const MIN_COMPATIBLE_DESKTOP_VERSION = 0
