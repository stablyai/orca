import { describe, expect, it, vi } from 'vitest'
import { completedCodexWarmup, warmCodexAccount } from './codex-warmup-inference'

const { request, close, run, mkdir } = vi.hoisted(() => ({
  request: vi.fn(),
  close: vi.fn(async () => true),
  run: vi.fn(),
  mkdir: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ mkdir }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => '/bin/codex' }))
vi.mock('../rate-limits/codex-fetcher', () => ({ buildWslCodexCommand: () => null }))
vi.mock('../codex/codex-app-server-connection', () => ({
  openCodexAppServerConnection: async () => ({ request, close })
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))

describe('isolated warmup inference', () => {
  it('accepts a completed OK turn despite nonfatal item diagnostics', () => {
    expect(
      completedCodexWarmup(
        [
          { type: 'item.completed', item: { type: 'error', text: 'diagnostic' } },
          { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } },
          { type: 'turn.completed' }
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n')
      )
    ).toBe(true)
    expect(completedCodexWarmup('{"type":"turn.completed"}')).toBe(false)
    expect(
      completedCodexWarmup('{"type":"item.completed","item":{"type":"command_execution"}}')
    ).toBe(false)
  })
  it('uses the account home, explicit lowest effort, and isolated execution after durable intent', async () => {
    request.mockResolvedValue({
      data: [{ model: 'gpt-5.4-mini', supportedReasoningEfforts: [{ reasoningEffort: 'none' }] }],
      nextCursor: null
    })
    const beforeSubmit = vi.fn(async () => {})
    run.mockImplementation(async () => {
      expect(beforeSubmit).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalled()
      return {
        code: 0,
        stdout:
          '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed"}',
        timedOut: false
      }
    })
    expect(
      await warmCodexAccount({
        home: '/accounts/a',
        stateDirectory: '/state',
        signal: new AbortController().signal,
        beforeSubmit
      })
    ).toBe(true)
    expect(run.mock.lastCall?.[0]).toMatchObject({
      env: { CODEX_HOME: '/accounts/a' },
      cwd: '/state/codex-warmup-empty'
    })
    expect(run.mock.lastCall?.[0].args).toEqual(
      expect.arrayContaining([
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--model',
        'gpt-5.4-mini',
        'model_reasoning_effort="none"'
      ])
    )
  })
  it('does not silently retry an unsupported model with an expensive default', async () => {
    run.mockClear()
    request.mockResolvedValue({
      data: [{ model: 'unknown', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
      nextCursor: null
    })
    const beforeSubmit = vi.fn(async () => {})
    expect(
      await warmCodexAccount({
        home: '/accounts/a',
        stateDirectory: '/state',
        signal: new AbortController().signal,
        beforeSubmit
      })
    ).toBe(false)
    expect(beforeSubmit).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
