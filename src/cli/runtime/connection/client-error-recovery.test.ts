import { describe, expect, it } from 'vitest'
import { formatCliError } from '../../output/cli-error'
import { attachMutationRecovery } from './client-error-recovery'
import { RuntimeRpcFailureError } from './types'

const refusal = (data: unknown) =>
  new RuntimeRpcFailureError({
    id: 'req',
    ok: false,
    error: { code: 'selector_not_found', message: 'No repo matches --repo nope.', data },
    _meta: { runtimeId: 'rt' }
  })

describe('worker-start refusal recovery', () => {
  it('adds no request id or --worktree hint to a refusal that applied nothing on --repo', () => {
    const error = attachMutationRecovery(
      refusal({ effectsApplied: false, flag: '--repo', value: 'nope' }),
      'request-1'
    )
    expect(formatCliError(error, { worktreeSelector: 'id:wt' })).toBe(
      'No repo matches --repo nope.'
    )
  })

  it('keeps the request id when the outcome is not known to be effect-free', () => {
    const error = attachMutationRecovery(refusal(undefined), 'request-1')
    expect(formatCliError(error)).toContain('Orchestration mutation request ID: request-1.')
  })
})
