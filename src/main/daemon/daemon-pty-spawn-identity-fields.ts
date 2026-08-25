import type { TerminalOwnerIdentity } from '../../shared/terminal-owner-identity'
import type { PtySpawnResult } from '../providers/types'
import type { CreateOrAttachResult } from './types'

export function daemonPtySpawnIdentityFields(
  result: Pick<CreateOrAttachResult, 'incarnationId'>,
  ownerIdentity: TerminalOwnerIdentity | undefined
): Pick<PtySpawnResult, 'incarnationId' | 'ownerIdentity'> {
  return {
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(ownerIdentity ? { ownerIdentity } : {})
  }
}
