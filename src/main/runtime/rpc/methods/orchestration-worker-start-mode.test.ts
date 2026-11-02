/** Launch mode follows settings, with explicit fallback reasons; unsupported preference must not refuse ordinary worker-start. */

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it } from 'vitest'
import {
  decideWorkerStartMode,
  downgradeWorkerStartModeForHost,
  type WorkerStartModeReceipt
} from './orchestration-worker-start-mode'

const STRUCTURED_DEFAULT = {
  nativeChatProviders: EVERY_AGENT_CHAT
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
    ['the agent is set to CLI', { ...STRUCTURED_DEFAULT, nativeChatProviders: { claude: false } }],
    ['the agent has no saved choice', {}],
    ['no settings at all', null]
  ])('starts a terminal worker when %s', (_name, settings) => {
    expect(decide({ settings })).toMatchObject({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default'
    })
  })
})

describe('a structured default this dispatch cannot honour', () => {
  it.each([
    ['a remote --on', { on: 'server-1' }, 'remote_execution_host'],
    ['an existing --terminal', { terminal: 'term_1' }, 'reused_terminal'],
    ['a non-structured agent', { agent: 'cursor' }, 'agent_without_structured_session']
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
    // Both routine dispatch flags previously forced PTY mode.
    expect(decide({ params: { agent: 'claude', ...params } })).toMatchObject({
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default'
    })
  })

  it('keeps the current worktree structured, which is the ordinary dispatch', () => {
    expect(decide({ params: { agent: 'codex', worktree: 'current' } }).mode).toBe('structured')
  })

  // A custom launch command never decides the surface; native chat runs it as the program.
  it.each([
    ['claude', 'claude-wrapper'],
    ['codex', 'codex-nightly']
  ] as const)('keeps a %s worker structured with launch command %s', (agent, command) => {
    const settings = { ...STRUCTURED_DEFAULT, agentCmdOverrides: { [agent]: command } }
    expect(decide({ params: { agent }, settings })).toMatchObject({
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default'
    })
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
