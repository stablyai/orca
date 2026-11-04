import type { PairingCandidatePath } from './pairing-candidate-race'
import type { ConnectionLogSink } from './types'

const PATH_PREFIX: Record<PairingCandidatePath, string> = {
  direct: 'Direct: ',
  relay: 'Relay: '
}

// Attribute at the candidate seam so direct LAN diagnostics cannot look like relay retries when call sites omit path labels.
export function attributePairingLogPath(
  path: PairingCandidatePath,
  onLog: ConnectionLogSink | undefined
): ConnectionLogSink | undefined {
  if (!onLog) {
    return undefined
  }
  const prefix = PATH_PREFIX[path]
  return (entry) => {
    onLog(
      entry.message.startsWith(prefix) ? entry : { ...entry, message: `${prefix}${entry.message}` }
    )
  }
}
