import { describe, expect, it } from 'vitest'
import { formatTerminalClose, formatTerminalFocus, formatTerminalSend } from './terminal-format'

describe('formatTerminalFocus', () => {
  it('distinguishes superseded navigation from a winning focus', () => {
    expect(
      formatTerminalFocus({
        focus: {
          handle: 'term_stale',
          tabId: 'tab-stale',
          worktreeId: 'worktree-1',
          navigated: false
        }
      })
    ).toBe(
      'Focus request for terminal term_stale was superseded or host navigation was skipped (tab tab-stale).'
    )
    expect(
      formatTerminalFocus({
        focus: { handle: 'term_winner', tabId: 'tab-winner', worktreeId: 'worktree-1' }
      })
    ).toBe('Focused terminal term_winner (tab tab-winner).')
  })
})

describe('formatTerminalClose', () => {
  it('prints "PTY killed." only for a confirmed kill', () => {
    expect(
      formatTerminalClose({ close: { handle: 'term_local', tabId: 'tab-1', ptyKilled: true } })
    ).toBe('Closed terminal term_local. PTY killed.')
  })

  it('says the remote process was not confirmed stopped instead of claiming a kill', () => {
    expect(
      formatTerminalClose({
        close: {
          handle: 'term_remote',
          tabId: 'tab-1',
          ptyKilled: false,
          ptyStopVerdict: 'unverifiable',
          ptyStopReason: 'its SSH provider is no longer registered'
        }
      })
    ).toBe(
      'Closed terminal term_remote. The PTY was not confirmed stopped: its SSH provider is no longer registered.'
    )
  })

  it('names a PTY known to be live', () => {
    expect(
      formatTerminalClose({
        close: {
          handle: 'term_live',
          tabId: 'tab-1',
          ptyKilled: false,
          ptyStopVerdict: 'live'
        }
      })
    ).toBe('Closed terminal term_live. The PTY is live.')
  })
})

describe('formatTerminalSend', () => {
  it('exposes the provider and healthy delivery observation', () => {
    expect(
      formatTerminalSend({
        send: {
          handle: 'term_worker',
          accepted: true,
          bytesWritten: 8,
          prompt: {
            requestId: 'prompt-healthy',
            stages: ['input_accepted', 'turn_started'],
            provider: 'codex',
            observation: 'supported',
            processIncarnation: 'inc-1',
            generation: 1,
            baselineWorkingSequence: 0
          }
        }
      })
    ).toBe(
      [
        'Prompt prompt-healthy on term_worker: input_accepted -> turn_started.',
        'provider: codex',
        'delivery observation: supported'
      ].join('\n')
    )
  })

  it.each([
    {
      observation: 'permission' as const,
      warning: 'Resolve the permission prompt in the terminal',
      nextStep: '--retry-request prompt-unhealthy'
    },
    {
      observation: 'incarnation_replaced' as const,
      warning: 'the terminal process was replaced',
      nextStep: 'Inspect the current terminal before sending a new prompt'
    }
  ])('warns and gives a next step for $observation', ({ observation, warning, nextStep }) => {
    const output = formatTerminalSend({
      send: {
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 8,
        prompt: {
          requestId: 'prompt-unhealthy',
          stages: ['input_accepted'],
          provider: 'codex',
          observation,
          processIncarnation: 'inc-1',
          generation: 1,
          baselineWorkingSequence: 0
        }
      }
    })

    expect(output).toContain(`provider: codex`)
    expect(output).toContain(`delivery observation: ${observation}`)
    expect(output).toContain(`warning: delivery was not observed`)
    expect(output).toContain(warning)
    expect(output).toContain(nextStep)
  })

  it.each([
    { provider: 'claude' as const, expected: 'no turn start was observed' },
    { provider: 'unsupported' as const, expected: 'this provider cannot report delivery' },
    { provider: 'old-host' as const, expected: 'predates durable prompt receipts' }
  ])('warns per provider when delivery was not observed ($provider)', ({ provider, expected }) => {
    const output = formatTerminalSend({
      send: {
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 8,
        prompt: {
          requestId: 'prompt-unobserved',
          stages: ['input_accepted'],
          provider,
          observation: 'unsupported',
          processIncarnation: 'inc-1',
          generation: 1,
          baselineWorkingSequence: 0
        }
      }
    })

    expect(output).toContain(expected)
  })

  it('names the next command when a supported send never reached turn_started', () => {
    const output = formatTerminalSend({
      send: {
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 8,
        prompt: {
          requestId: 'prompt-swallowed',
          stages: ['input_accepted'],
          provider: 'claude',
          observation: 'supported',
          processIncarnation: 'inc-1',
          generation: 1,
          baselineWorkingSequence: 0
        }
      }
    })

    expect(output).toContain('no turn start was observed')
    expect(output).toContain('--retry-request prompt-swallowed --wait-submit <seconds>')
  })
})
