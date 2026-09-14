/**
 * The worker mode is the user's own setting, not a flag, and the fallback is never silent.
 *
 * Every case here is one a coordinator can hit on a routine `worker-start`. Before this became
 * settings-driven each of them was a REFUSAL, which was right for an explicit `--structured` and
 * wrong for a preference: a dispatch that cannot be a structured session must still start.
 */

import { describe, expect, it } from 'vitest'
import {
  decideWorkerStartMode,
  downgradeWorkerStartModeForHost,
  type WorkerStartModeReceipt
} from './orchestration-worker-start-mode'

const STRUCTURED_DEFAULT = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
}

function decide(
  overrides: {
    params?: Parameters<typeof decideWorkerStartMode>[0]['params']
    settings?: Parameters<typeof decideWorkerStartMode>[0]['settings']
  } = {}
): WorkerStartModeReceipt {
  return decideWorkerStartMode({
    params: { agent: 'claude', ...overrides.params },
    settings: overrides.settings === undefined ? STRUCTURED_DEFAULT : overrides.settings
  })
}

describe('worker start mode from the user default', () => {
  it.each(['claude', 'codex'] as const)('starts a local %s worker structured', (agent) => {
    expect(decide({ params: { agent } })).toMatchObject({
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default'
    })
  })

  it.each([
    ['native chat off', { ...STRUCTURED_DEFAULT, experimentalNativeChat: false }],
    ['chat-by-default off', { ...STRUCTURED_DEFAULT, openAgentTabsInChatByDefault: false }],
    ['structured off', { ...STRUCTURED_DEFAULT, experimentalStructuredNativeChat: false }],
    ['no settings at all', null]
  ])('starts a terminal worker when %s', (_name, settings) => {
    expect(decide({ settings })).toMatchObject({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default'
    })
  })

  it('says which mode ran even when the default was honoured', () => {
    expect(decide().detail).toContain('structured chat session')
    expect(decide({ settings: null }).detail).toContain('terminal agent')
  })
})

describe('a structured default this dispatch cannot honour', () => {
  it.each([
    ['a remote --on', { on: 'server-1' }, 'remote_execution_host'],
    ['an existing --terminal', { terminal: 'term_1' }, 'reused_terminal'],
    ['a non-structured agent', { agent: 'cursor' }, 'agent_without_structured_session'],
    ['no agent at all', { agent: undefined }, 'agent_without_structured_session']
  ])('falls back to a terminal worker for %s', (_name, params, reason) => {
    const receipt = decide({ params: { agent: 'claude', ...params } })
    expect(receipt).toMatchObject({ mode: 'terminal', preferred: 'structured', reason })
    // Never a silent fallback: the receipt states the default AND why it did not apply.
    expect(receipt.detail).toContain('Your default is a structured chat session')
  })

  it.each([
    ['a new-child worktree', { worktree: 'new-child' }],
    ['a new-top-level worktree', { worktree: 'new-top-level' }],
    ['--model', { model: 'opus' }],
    ['--effort with its model', { model: 'opus', effort: 'high' }],
    ['both at once', { worktree: 'new-child', model: 'opus', effort: 'high' }]
  ])('no longer downgrades for %s, which is what made structured unreachable', (_name, params) => {
    // Both flags are what a routine dispatch passes, and each used to force a PTY worker, so
    // orchestration never produced a structured chat in practice.
    expect(decide({ params: { agent: 'claude', ...params } })).toMatchObject({
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default'
    })
  })

  it('keeps the current worktree structured, which is the ordinary dispatch', () => {
    expect(decide({ params: { agent: 'codex', worktree: 'current' } }).mode).toBe('structured')
  })

  it('falls back rather than dropping a custom TUI launch the session cannot apply', () => {
    expect(
      decide({
        settings: { ...STRUCTURED_DEFAULT, agentCmdOverrides: { claude: 'claude-wrapper' } }
      })
    ).toMatchObject({ mode: 'terminal', reason: 'tui_launch_customization' })
  })

  // Neither provider is refused here on the client's platform: only the executing host knows
  // whether it can read a provider child's start time, and it answers at create time.
  it.each(['claude', 'codex'] as const)('leaves a Windows %s worker to the host', (agent) => {
    expect(decide({ params: { agent } }).mode).toBe('structured')
  })
})

describe('the executing host settles what the client cannot', () => {
  it.each([
    ['wsl', 'wsl_execution_runtime'],
    ['remote', 'remote_execution_host'],
    ['agent', 'structured_unsupported_on_host']
  ] as const)('downgrades on a %s refusal', (reason, expected) => {
    expect(downgradeWorkerStartModeForHost(decide(), { supported: false, reason })).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: expected
    })
  })

  it('downgrades on a refusal that names no reason', () => {
    expect(downgradeWorkerStartModeForHost(decide(), { supported: false }).reason).toBe(
      'structured_unsupported_on_host'
    )
  })

  it('leaves a supported structured start and an already-terminal receipt alone', () => {
    expect(downgradeWorkerStartModeForHost(decide(), { supported: true }).mode).toBe('structured')
    const terminal = decide({ settings: null })
    expect(downgradeWorkerStartModeForHost(terminal, { supported: false, reason: 'wsl' })).toBe(
      terminal
    )
  })
})
