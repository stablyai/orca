import { describe, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

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

  it('gives only the repair step when two folder workspaces share an id', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const repair = 'Remove one of these folder workspaces in the Orca app and add its folder again.'

    reportCliError(
      new RuntimeRpcFailureError({
        id: 'req_selector',
        ok: false,
        error: {
          code: 'selector_ambiguous',
          message: 'selector_ambiguous',
          data: { selector: 'folder:hub-a', duplicateFolderId: 'hub-a', nextSteps: [repair] }
        },
        _meta: { runtimeId: 'runtime_local' }
      }),
      true,
      { commandPath: ['worktree', 'rm'], worktreeSelector: 'folder:hub-a' }
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).error.data.nextSteps).toEqual([repair])
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

describe('CLI error recovery', () => {
  it('prefers structured recovery over generic computer hints in text output', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown flag --forcce', {
      nextSteps: ['Did you mean: --force']
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Did you mean: --force')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('preserves the local request-id protection for an RPC runtime-unavailable error', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_runtime_mutation',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: 'Re-issue the same RPC command with --retry-request mutation_2.',
        data: {
          orchestrationRequestId: 'mutation_2',
          nextSteps: ['Read the RPC mutation status before retrying.']
        }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    expect(formatCliError(error)).toBe(
      'Re-issue the same RPC command with --retry-request mutation_2.'
    )
  })
})
