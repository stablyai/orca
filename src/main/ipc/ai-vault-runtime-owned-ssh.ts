import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { scanSshAiVaultSessions } from '../ai-vault/ssh-session-list'
import {
  abandonRemoteSessionScanOnCancel,
  throwIfAiVaultScanCancelled
} from '../ai-vault/ai-vault-scan-cancellation'
import type { RuntimeOwnedSshAiVaultHost } from '../ai-vault/runtime-owned-ssh-session-list'
import { getActiveSshAiVaultHostInfo } from './ssh'

export type RuntimeOwnedSshAiVaultScanner = (
  environmentId: string,
  targetId: string,
  args: AiVaultListArgs,
  options?: { timeoutMs?: number }
) => Promise<AiVaultListResult>

export async function scanSshAiVaultSessionsByOwner(args: {
  targetId: string
  listArgs?: AiVaultListArgs
  signal?: AbortSignal
  ownedTimeoutMs: number
  findOwner?: (targetId: string) => Promise<RuntimeOwnedSshAiVaultHost | null>
  scanOwned?: RuntimeOwnedSshAiVaultScanner
}): Promise<AiVaultListResult> {
  if (
    !isRuntimeOwnedSshTargetId(args.targetId) &&
    !getActiveSshAiVaultHostInfo(args.targetId) &&
    args.findOwner &&
    args.scanOwned
  ) {
    try {
      const owner = await args.findOwner(args.targetId)
      if (owner) {
        throwIfAiVaultScanCancelled(args.signal)
        return await abandonRemoteSessionScanOnCancel(
          args.scanOwned(owner.environmentId, owner.targetId, args.listArgs ?? {}, {
            timeoutMs: args.ownedTimeoutMs
          }),
          args.signal
        )
      }
    } catch (error) {
      if (isAiVaultScanCancelledError(error)) {
        throw error
      }
      // Fall through to the local SSH issue path so one dead pairing cannot
      // discard sibling all-hosts legs.
    }
  }
  return scanSshAiVaultSessions(args.targetId, args.listArgs, {
    signal: args.signal
  })
}
