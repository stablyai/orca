// Which paired device last drove each agent: the person behind a turn, attested by the transport
// (never by the message text). Agents ask for their own entry through `orchestration.turnSender`,
// which identifies the asking terminal/session from orcad's own launch evidence, not from params.
// Shared cloud workspaces use it so `git push` runs as the teammate who asked for the work.
import type { RpcCallerIdentity } from '../rpc/rpc-caller-identity'

export type DrivingDevice = { deviceId: string; at: number }

const MAX_ENTRIES = 4096
const entries = new Map<string, DrivingDevice>()

export function agentSessionSenderKey(sessionId: string): string {
  return `session:${sessionId}`
}

export function terminalSenderKey(handle: string): string {
  return `terminal:${handle}`
}

/**
 * Records a person's input. Only paired devices are people with a device identity; the local CLI
 * (agents, scripts) and local windows never overwrite who drove the agent.
 */
export function recordDrivingDevice(
  key: string,
  caller: RpcCallerIdentity | undefined,
  now: number = Date.now()
): void {
  if (caller?.kind !== 'paired-device' || !caller.deviceId) {
    return
  }
  entries.delete(key)
  entries.set(key, { deviceId: caller.deviceId, at: now })
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      entries.delete(oldest)
    }
  }
}

export function drivingDeviceFor(key: string): DrivingDevice | null {
  return entries.get(key) ?? null
}

/** Tests only. */
export function resetDrivingDevices(): void {
  entries.clear()
}
