import type { PtyGrid } from './attached-pty-size'

/** The real grid of each PTY a repaint nudge holds one row off; an attach meanwhile commits this. */
export const pendingRepaintGrids = new Map<string, PtyGrid>()
