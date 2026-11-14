import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Persist fallback endpoints across restarts so paired phones stay reachable even when the preferred port later becomes free (STA-1511).

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'
const FALLBACK_LADDER_SIZE = 31
// Reserve 6769 for pnpm dev (main-process-runtime-launch.ts) so other instances cannot steal its paired endpoint.
const DEV_PINNED_WS_PORT = 6769

// Try deterministic ports below OS dynamic ranges; rebooted Hyper-V/WSL reservations otherwise move advertised ports.
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

// Drop unusable persisted ports so next launch retries preferred instead of chasing fallbacks.
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
    // Failed persistence must not prevent startup; phones may need re-pairing after restart.
  }
}
