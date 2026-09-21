// Clamp terminal dimensions to the PTY's supported range (cols 20–240, rows 8–120).
export function clampTerminalViewport(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(240, Math.round(cols))),
    rows: Math.max(8, Math.min(120, Math.round(rows)))
  }
}
