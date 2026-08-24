export type MobileTerminalResizePaint =
  | { readonly kind: 'init'; readonly data: string }
  | { readonly kind: 'resize' }

/** A resized frame may carry a rewrapped scrollback snapshot. Empty serialized
 *  is the absence of that snapshot, not a blank screen — replaying it remounts
 *  xterm and wipes a live TUI (Claude Code on Linux hosts). */
export function resolveMobileTerminalResizePaint(serialized: unknown): MobileTerminalResizePaint {
  return typeof serialized === 'string' && serialized.length > 0
    ? { kind: 'init', data: serialized }
    : { kind: 'resize' }
}
