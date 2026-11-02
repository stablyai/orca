import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

/** Keep labels stable across upgrades, isolated by profile and protocol. */
export function macDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  const profileKey = createHash('sha256').update(resolve(userDataPath)).digest('hex').slice(0, 16)
  return `com.stablyai.orca.terminal.${profileKey}.v${protocolVersion}`
}
