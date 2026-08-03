import { DaemonClient } from './client'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, type ShutdownIfIdleResult } from './types'
import { getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

const LEGACY_IDLE_RETIREMENT_TIMEOUT_MS = 500

export async function retireLegacyDaemonIfIdle(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  if (protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION) {
    return false
  }

  const client = new DaemonClient({
    socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
    tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
    protocolVersion
  })
  const deadlineMs = Date.now() + LEGACY_IDLE_RETIREMENT_TIMEOUT_MS
  try {
    await client.ensureConnectedWithin(Math.max(1, deadlineMs - Date.now()))
    const result = await client.request<ShutdownIfIdleResult>(
      'shutdownIfIdle',
      undefined,
      Math.max(1, deadlineMs - Date.now())
    )
    return result.retiring === true
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}
