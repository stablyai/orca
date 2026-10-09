import { describe, expect, it } from 'vitest'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'
import { attachDurableMutationRecovery } from './terminal-prompt-mutation-recovery'
import { orchestrationMutationRecoveryError } from '../orchestration-mutation-recovery'

const requestId = 'retired-request'
const message = `Orca no longer keeps a record of request ${requestId} (records are kept for 30 days), so it can't tell whether it already ran. Check the work it would have created; to do it again, run the command without --retry-request.`
const data = { requestId, reason: 'retry_record_retired' }

describe('retired retry recovery', () => {
  it.each(['terminal.send', 'orchestration.send'])(
    'preserves useful %s refusal text without advising the same retry',
    (method) => {
      const refusal = new RuntimeRpcFailureError({
        id: 'rpc',
        ok: false,
        error: { code: 'operation_unknown', message, data },
        _meta: { runtimeId: 'host' }
      })
      const recovered = orchestrationMutationRecoveryError(
        attachDurableMutationRecovery(refusal, requestId, ['orca', 'command'], method)
      )
      expect(recovered).toBeInstanceOf(RuntimeRpcFailureError)
      if (!(recovered instanceof RuntimeRpcFailureError)) {
        throw new Error('expected RPC failure')
      }
      expect(recovered.message).toContain('without --retry-request')
      expect(recovered.message).not.toContain(`--retry-request ${requestId}`)
      expect(recovered.message).not.toContain('do not retry it without that ID')
      expect(recovered.message).not.toContain('may already have taken effect')
      expect(recovered.data).toMatchObject({
        reason: 'retry_record_retired',
        orchestrationRequestId: requestId
      })
      expect(recovered.data).not.toHaveProperty('recovery.retryCommand')
    }
  )

  it('does not append generic same-id recovery even when an older wrapper changes the error code', () => {
    const refusal = new RuntimeClientError('runtime_unavailable', message, {
      ...data,
      orchestrationRequestId: requestId,
      originalCommand: ['orca', 'command']
    })
    expect(orchestrationMutationRecoveryError(refusal)).toBe(refusal)
  })
})
