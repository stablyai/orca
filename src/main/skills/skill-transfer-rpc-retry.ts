import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'

const TRANSFER_RPC_ATTEMPTS = 3

export function throwIfSkillTransferCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
  }
}

export async function retrySkillTransferRpc<T>(input: {
  call: () => Promise<T>
  signal?: AbortSignal
  retryable?: (error: unknown) => boolean
  checkCancellationAfterSuccess?: boolean
}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    throwIfSkillTransferCancelled(input.signal)
    try {
      const result = await input.call()
      if (input.checkCancellationAfterSuccess !== false) {
        throwIfSkillTransferCancelled(input.signal)
      }
      return result
    } catch (error) {
      throwIfSkillTransferCancelled(input.signal)
      if (attempt >= TRANSFER_RPC_ATTEMPTS || input.retryable?.(error) === false) {
        throw error
      }
    }
  }
}
