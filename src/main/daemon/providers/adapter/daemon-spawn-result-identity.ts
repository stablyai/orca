import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { DaemonCreateOrAttachResult as CreateOrAttachResult } from '../../protocol/daemon-create-or-attach-result'

export function daemonSpawnResultIdentity(
  result: CreateOrAttachResult
): Pick<PtySpawnResult, 'incarnationId' | 'agentSessionEnsure' | 'launchAgent'> {
  return {
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {}),
    ...(result.launchAgent ? { launchAgent: result.launchAgent } : {})
  }
}
