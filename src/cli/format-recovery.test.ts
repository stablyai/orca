import { describe, expect, it, vi } from 'vitest'

import { reportCliError } from './format'
import { RuntimeRpcFailureError } from './runtime-client'

function selectorAmbiguous(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_ambiguous', message: 'selector_ambiguous' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

describe('ambiguous selector recovery', () => {
  it('carries the ambiguous --worktree value into the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(selectorAmbiguous(), true, {
      commandPath: ['terminal', 'create'],
      worktreeSelector: 'name:feature'
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'selector_ambiguous',
        data: {
          ambiguousSelectors: [{ flag: '--worktree', selector: 'name:feature' }],
          nextSteps: expect.arrayContaining([expect.stringContaining('identity:<identity.key>')])
        }
      }
    })
    log.mockRestore()
  })
})

describe('worktree selector recovery', () => {
  it('keeps the selector grammar when the error already carries mutation recovery data', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(
      new RuntimeRpcFailureError({
        id: 'req_selector',
        ok: false,
        error: {
          code: 'selector_not_found',
          message: 'selector_not_found',
          // Preserve the request ID already attached by mutation recovery.
          data: { orchestrationRequestId: 'req_abc', nextSteps: ['Run request-show first.'] }
        },
        _meta: { runtimeId: 'runtime_local' }
      }),
      true,
      { commandPath: ['orchestration', 'worker-start'], worktreeSelector: 'bare-repo-id' }
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        data: {
          orchestrationRequestId: 'req_abc',
          selector: 'bare-repo-id',
          validSelectorForms: expect.arrayContaining(['current']),
          nextSteps: expect.arrayContaining(['Run request-show first.'])
        }
      }
    })
    log.mockRestore()
  })
})
