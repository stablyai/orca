import { describe, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

function selectorNotFound(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_not_found', message: 'selector_not_found' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

function selectorAmbiguous(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_ambiguous', message: 'selector_ambiguous' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

describe('ambiguous selector recovery', () => {
  it('names the ambiguous --repo value and the exact forms for twin projects', () => {
    const output = formatCliError(selectorAmbiguous(), {
      commandPath: ['worktree', 'create'],
      repoSelector: 'app'
    })

    expect(output).toContain('More than one project matches --repo "app"')
    expect(output).toContain('id:<repo-id> or path:<absolute-path>')
    expect(output).toContain('orca repo list --json')
  })

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
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        data: {
          nextSteps: expect.arrayContaining([
            'List the exact values with `orca worktree list --json`.'
          ])
        }
      }
    })
    log.mockRestore()
  })

  it('keeps the listing on the paired server the command chose', () => {
    const output = formatCliError(selectorAmbiguous(), {
      commandPath: ['repo', 'show'],
      repoSelector: 'app',
      remoteServerSelected: true
    })

    expect(output).toContain('`orca repo list --json`, passing the same server flag')
  })

  it('stays silent when no selector flag was passed', () => {
    expect(formatCliError(selectorAmbiguous(), { commandPath: ['repo', 'list'] })).toBe(
      'selector_ambiguous'
    )
  })
})

describe('worktree selector recovery', () => {
  it('names the offending value and the valid forms on a bare repo id', () => {
    const output = formatCliError(selectorNotFound(), {
      commandPath: ['orchestration', 'worker-start'],
      worktreeSelector: 'id:github:stablyai/orca'
    })

    expect(output).toContain('No Orca workspace matched the worktree selector')
    expect(output).toContain('id:github:stablyai/orca')
    expect(output).toContain('Did you mean: id:github:stablyai/orca::<absolute-path>')
    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('a bare repository id is not a worktree id')
  })

  it('carries the same recovery into the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(selectorNotFound(), true, {
      commandPath: ['terminal', 'create'],
      worktreeSelector: 'path:/nope'
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'selector_not_found',
        data: { selector: 'path:/nope', validSelectorForms: expect.arrayContaining(['current']) }
      }
    })
    log.mockRestore()
  })

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

  it('keeps both recoveries in the text message for a local selector error', () => {
    const output = formatCliError(
      new RuntimeClientError('selector_not_found', 'selector_not_found', {
        orchestrationRequestId: 'req_abc',
        nextSteps: ['Run request-show first.']
      }),
      { worktreeSelector: 'bare-repo-id' }
    )

    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('Run request-show first.')
  })

  it('stays silent when no worktree selector was passed', () => {
    expect(formatCliError(selectorNotFound(), { commandPath: ['worktree', 'show'] })).toBe(
      'selector_not_found'
    )
  })
})

describe('CLI error recovery', () => {
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

  it('tells an older server to reprovision when its computer sidecar is missing', () => {
    // Older servers return generic steps without naming the server installation.
    const error = new RuntimeRpcFailureError({
      id: 'req_sidecar_exit',
      ok: false,
      error: {
        code: 'accessibility_error',
        message: 'computer sidecar exited with code 1',
        data: {
          nextSteps: [
            'Run `orca computer capabilities --json` to confirm the provider is available before retrying.'
          ]
        }
      },
      _meta: { runtimeId: 'runtime_orcad' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'list-apps'] })
    expect(output).toContain('update or reprovision the server')

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true, { commandPath: ['computer', 'list-apps'] })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'accessibility_error',
        data: {
          nextSteps: expect.arrayContaining([
            expect.stringContaining('update or reprovision the server')
          ])
        }
      }
    })
    log.mockRestore()
  })

  it('preserves structured recovery for a local runtime-unavailable error', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'The local runtime has a recovery step.',
      { nextSteps: ['Run `orca runtime status --json` and retry.'] }
    )

    expect(formatCliError(error)).toBe(
      [
        'The local runtime has a recovery step.',
        'Next step: Run `orca runtime status --json` and retry.'
      ].join('\n')
    )
  })

  it('preserves structured recovery for an RPC runtime-unavailable error', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_runtime_recovery',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: 'The runtime returned a recovery step.',
        data: { nextSteps: ['Reconnect the runtime, then retry.'] }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    expect(formatCliError(error)).toBe(
      [
        'The runtime returned a recovery step.',
        'Next step: Reconnect the runtime, then retry.'
      ].join('\n')
    )
  })

  it('keeps startup guidance when a local runtime-unavailable error has no next steps', () => {
    const message = 'Could not connect to the running Orca app.'

    expect(formatCliError(new RuntimeClientError('runtime_unavailable', message))).toBe(
      `${message}\nOrca is not running. Run 'orca open' first.`
    )
  })

  it('keeps startup guidance when an RPC runtime-unavailable error has no next steps', () => {
    const message = 'The RPC runtime is unavailable.'
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_startup_fallback',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    expect(formatCliError(error)).toBe(`${message}\nOrca is not running. Run 'orca open' first.`)
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

  it('does not replace mutation recovery with generic runtime startup advice', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'Re-issue the same command with --retry-request mutation_1.',
      {
        orchestrationRequestId: 'mutation_1',
        nextSteps: ['Read the mutation request status before retrying.']
      }
    )

    const output = formatCliError(error)

    expect(output).toBe('Re-issue the same command with --retry-request mutation_1.')
  })
})

describe('stale terminal handle recovery', () => {
  function staleHandle(): RuntimeRpcFailureError {
    return new RuntimeRpcFailureError({
      id: 'req_stale',
      ok: false,
      error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' },
      _meta: { runtimeId: 'runtime_local' }
    })
  }

  it('points a terminal verb with no server selected at --environment', () => {
    const output = formatCliError(staleHandle(), {
      commandPath: ['terminal', 'send'],
      remoteServerSelected: false
    })

    expect(output).toContain('terminal_handle_stale')
    expect(output).toContain('Next step: Terminal handles belong to the Orca server')
    expect(output).toContain('--environment <server>')
  })

  it('adds the hint to the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(staleHandle(), true, {
      commandPath: ['terminal', 'read'],
      remoteServerSelected: false
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'terminal_handle_stale',
        data: { nextSteps: [expect.stringContaining('--environment <server>')] }
      }
    })
    log.mockRestore()
  })

  it('stays silent once a server was already selected', () => {
    expect(
      formatCliError(staleHandle(), {
        commandPath: ['terminal', 'send'],
        remoteServerSelected: true
      })
    ).toBe('terminal_handle_stale')
  })
})
