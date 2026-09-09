import type { PairingCandidatePath } from './pairing-candidate-race'
import type { ConnectionLogSink } from './types'

const PATH_PREFIX: Record<PairingCandidatePath, string> = {
  direct: 'Direct: ',
  relay: 'Relay: '
}

// Why: the direct and relay candidates race into one pairing log, and only the
// relay call sites prefixed themselves — so unlabelled direct lines
// ("Reconnecting (attempt 2)", detail 10.5.0.2:6768) read as the relay
// retrying a LAN address. Attributing at the candidate seam covers every line
// each path emits, including ones whose call site forgets to say which it is.
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
