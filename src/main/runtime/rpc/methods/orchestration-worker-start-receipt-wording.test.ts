/**
 * The exact sentences `orchestration.workerStart` puts in its mode receipt.
 *
 * These were unpinned when the decision moved to `main/agent-launch/agent-launch-mode`: the
 * existing suites assert `toContain` fragments ('terminal agent', 'cannot create'), and the CLI
 * suite asserts a receipt handed to it by a mock rather than one this code produced. Every one of
 * them stayed green against a deliberately corrupted vocabulary, so nothing was actually holding
 * the wording. A dispatch receipt is the only place a structured→terminal downgrade explains
 * itself, so the whole sentence is the contract, not a fragment of it.
 */

import { describe, expect, it } from 'vitest'
import {
  decideWorkerStartMode,
  downgradeWorkerStartModeForHost,
  type WorkerStartModeReceipt
} from './orchestration-worker-start-mode'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
} as const

function structuredReceipt(): WorkerStartModeReceipt {
  const receipt = decideWorkerStartMode({
    params: { agent: 'claude' },
    settings: STRUCTURED_PREFERENCE
  })
  expect(receipt.mode).toBe('structured')
  return receipt
}

function downgradeSentence(why: string): string {
  return `Your default is a structured chat session, but ${why}; started a terminal agent worker instead.`
}

describe('worker-start mode receipt wording', () => {
  it('states the settings default when the user has no structured preference', () => {
    expect(decideWorkerStartMode({ params: { agent: 'claude' }, settings: null })).toEqual({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'Started a terminal agent worker, the default for new agent tabs in your settings.'
    })
  })

  it('states the settings default when the launch is structured', () => {
    expect(structuredReceipt()).toEqual({
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default',
      detail:
        'Started a structured chat session worker, the default for new agent tabs in your settings.'
    })
  })

  it.each([
    [
      'remote execution host',
      { agent: 'claude', on: 'server-1' },
      'remote_execution_host',
      'this worker runs on a remote execution host'
    ],
    [
      'reused terminal',
      { agent: 'claude', terminal: 'term_1' },
      'reused_terminal',
      '--terminal reuses a running terminal agent'
    ],
    [
      'agent with no structured session',
      { agent: 'grok' },
      'agent_without_structured_session',
      'this agent has no structured session'
    ]
  ])('names the %s downgrade in full', (_label, params, reason, why) => {
    expect(decideWorkerStartMode({ params, settings: STRUCTURED_PREFERENCE })).toEqual({
      mode: 'terminal',
      preferred: 'structured',
      reason,
      detail: downgradeSentence(why)
    })
  })

  it('names a custom TUI launch as the downgrade', () => {
    expect(
      decideWorkerStartMode({
        params: { agent: 'claude' },
        settings: { ...STRUCTURED_PREFERENCE, agentDefaultArgs: { claude: '--custom' } }
      })
    ).toEqual({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'tui_launch_customization',
      detail: downgradeSentence(
        'this agent has a custom launch command, arguments or environment that only a terminal applies'
      )
    })
  })

  it.each([
    [
      'an unanswered host',
      null,
      'structured_support_unknown',
      'the execution host has not established structured session support'
    ],
    [
      'a host refusal with no reason',
      { supported: false },
      'structured_unsupported_on_host',
      'the execution host cannot create one here'
    ],
    [
      'a WSL workspace',
      { supported: false, reason: 'wsl' as const },
      'wsl_execution_runtime',
      'this workspace runs under WSL'
    ],
    [
      'a remote workspace',
      { supported: false, reason: 'remote' as const },
      'remote_execution_host',
      'this worker runs on a remote execution host'
    ]
  ])('names %s in full', (_label, support, reason, why) => {
    expect(downgradeWorkerStartModeForHost(structuredReceipt(), support)).toEqual({
      mode: 'terminal',
      preferred: 'structured',
      reason,
      detail: downgradeSentence(why)
    })
  })

  it('leaves a settled terminal receipt untouched', () => {
    const terminal = decideWorkerStartMode({ params: { agent: 'claude' }, settings: null })
    expect(downgradeWorkerStartModeForHost(terminal, null)).toEqual(terminal)
  })
})
