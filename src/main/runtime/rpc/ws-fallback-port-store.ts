import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Why: when the preferred WS port is taken (second Orca instance), the OS
// assigns a random port. Paired mobile devices store ws://ip:port endpoints,
// so a port that changes on every restart permanently orphans those pairings
// (STA-1511). Persist the assigned fallback so the same instance re-binds the
// same port next launch — the transport binds a persisted fallback BEFORE the
// preferred port, so pairings survive even when the preferred port is free
// again.

const FALLBACK_PORT_FILE = 'mobile-ws-fallback-port.json'

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
