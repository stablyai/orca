/**
 * The bytes a terminal snapshot may occupy on the way to this client, or nothing when it has no
 * ceiling of its own.
 *
 * Native: the socket delivers a stream frame as its own message with no per-message cap above it,
 * so the desktop's own 512 KiB budget is the only one and the subscribe carries no field. Sending
 * one would shrink a phone's scrollback for a limit that does not exist here.
 *
 * The `.web.ts` sibling is where this earns its name: inside the shell every event is one bridge
 * frame under a hard byte cap, and an ANSI snapshot escapes into JSON at well over 1.3x.
 */
export function mobileTerminalSnapshotByteBudget(): number | undefined {
  return undefined
}
