import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Why: when the preferred WS port is taken (second Orca instance), paired
// mobile devices store ws://ip:port endpoints, so a port that changes on every
// restart orphans those pairings (STA-1511). Persist the fallback so the same
// instance re-binds it next launch — the transport binds a persisted fallback
// BEFORE the preferred port, so pairings survive even when the preferred port
// is free again.

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'
const FALLBACK_LADDER_SIZE = 31
// `pnpm dev` pins 6769 beside packaged Orca (devWsPort in main-process-runtime-launch.ts);
// no other instance's ladder may take it, or dev's paired phones lose their endpoint.
const DEV_PINNED_WS_PORT = 6769

// Deterministic rungs just above the preferred port. They sit below every OS
// dynamic range, so a Windows Hyper-V/WSL reservation (redrawn on reboot in
// that range) cannot move the advertised port the way an OS-assigned port did.
export function wsFallbackPortLadder(preferredPort: number): number[] {
  if (preferredPort === 0) {
    return []
  }
  const last = Math.min(65535, preferredPort + FALLBACK_LADDER_SIZE)
  return Array.from(
    { length: last - preferredPort },
    (_, index) => preferredPort + 1 + index
  ).filter((port) => port !== DEV_PINNED_WS_PORT)
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
}

export function readWsFallbackPort(userDataPath: string): number | undefined {
  try {
    const raw = readFileSync(join(userDataPath, FALLBACK_PORT_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      isValidPort((parsed as { port?: unknown }).port)
    ) {
      return (parsed as { port: number }).port
    }
  } catch {
    // Missing or corrupt file — treated as "no previous fallback".
  }
  return undefined
}

// A persisted port that no longer binds is dropped, not rewritten, so the next
// launch returns to the preferred port instead of chasing another fallback.
export function clearWsFallbackPort(userDataPath: string): void {
  try {
    rmSync(join(userDataPath, FALLBACK_PORT_FILE), { force: true })
  } catch {
    // Best-effort like the write: a stale file only costs one failed bind.
  }
}

export function writeWsFallbackPort(userDataPath: string, port: number): void {
  if (!isValidPort(port)) {
    return
  }
  try {
    writeFileSync(join(userDataPath, FALLBACK_PORT_FILE), JSON.stringify({ port }), 'utf8')
  } catch {
    // Why: persistence is best-effort — failing to record the port must not
    // break transport startup; the cost is a re-pair after the next restart.
  }
}
