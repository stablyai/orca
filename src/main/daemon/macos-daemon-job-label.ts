import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

/** One job per profile and protocol, including jobs retained across app upgrades. */
export function macDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  const profileKey = createHash('sha256').update(resolve(userDataPath)).digest('hex').slice(0, 16)
  return `com.stablyai.orca.terminal.${profileKey}.v${protocolVersion}`
}
