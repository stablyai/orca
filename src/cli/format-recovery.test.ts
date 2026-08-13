import { describe, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

describe('CLI error recovery', () => {
  it('preserves response-loss recovery data in JSON output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(
      new RuntimeClientError(
        'runtime_unavailable',
        'The operation may have completed; verify before retrying.',
        {
          requestPhase: 'awaiting_response',
          mutationMayHaveCompleted: true,
          nextSteps: ['Run: orca worktree list --json.']
        }
      ),
      true
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'runtime_unavailable',
        data: {
          requestPhase: 'awaiting_response',
          mutationMayHaveCompleted: true,
          nextSteps: ['Run: orca worktree list --json.']
        }
      },
      _meta: { runtimeId: null }
    })
  })

  it('reports that a sent worktree create may have completed', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'The worktree.create operation may have completed after the runtime connection closed.',
      {
        requestPhase: 'awaiting_response',
        mutationMayHaveCompleted: true,
        nextSteps: ['Run: orca worktree list --json before retrying.']
      }
    )

    const output = formatCliError(error)

    expect(output).toContain('may have completed')
    expect(output).toContain('Next step: Run: orca worktree list --json before retrying.')
    expect(output).not.toContain('Orca is not running')
  })

  it('does not add the not-running hint to a completion warning without next steps', () => {
    const output = formatCliError(
      new RuntimeClientError(
        'runtime_unavailable',
        'The browser.tabCreate operation may have completed.',
        {
          requestPhase: 'awaiting_response',
          mutationMayHaveCompleted: true
        }
      )
    )

    expect(output).toContain('may have completed')
    expect(output).not.toContain('Orca is not running')
  })

  it('prints did-you-mean next steps for an unknown-command error carrying data', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown command: worktree remov', {
      suggestions: ['worktree rm'],
      nextSteps: ['Did you mean: orca worktree rm']
    })

    const output = formatCliError(error)

    expect(output).toContain('Unknown command: worktree remov')
    expect(output).toContain('Next step: Did you mean: orca worktree rm')
  })

  it('prefers structured recovery over generic computer hints in text output', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown flag --forcce', {
      nextSteps: ['Did you mean: --force']
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Did you mean: --force')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('prefers RPC recovery over generic computer hints in text output', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_recovery',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown runtime argument',
        data: { nextSteps: ['Use the runtime-specific option'] }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Use the runtime-specific option')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('keeps generic computer hints when an RPC error has no recovery data', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_fallback',
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid computer argument' },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Fix the command flags or RPC params')
  })
})
