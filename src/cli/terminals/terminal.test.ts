import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import type { CliStatusResult } from '../../shared/runtime-session-contracts'
import '../../shared/protocol-version'
import {
  TERMINAL_SPLIT_DIRECTION_RUNTIME_CAPABILITY,
  TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY
} from '../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode

function terminalClient(
  call: RuntimeClient['call'],
  runtime?: CliStatusResult['runtime']
): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-terminal-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  if (runtime) {
    vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        app: { running: runtime.reachable, pid: runtime.reachable ? 123 : null },
        runtime,
        graph: { state: runtime.reachable ? 'ready' : 'not_running' }
      },
      _meta: { runtimeId: runtime.runtimeId ?? 'none' }
    })
  }
  return client
}

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('fails closed when the host downgrades after the prompt capability preflight', async () => {
    const response = {
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 8 } },
      _meta: { runtimeId: 'old-runtime-after-restart' }
    }
    const call = vi.fn().mockResolvedValue(response)
    const client = terminalClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'new-runtime-before-restart',
      capabilities: [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY]
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const error = await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'continue'],
        ['enter', true],
        ['retry-request', '11111111-1111-4111-8111-111111111111'],
        ['wait-submit', '3']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
      .then(() => undefined)
      .catch((caught: unknown) => caught)

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ agentPrompt: true, waitSubmitMs: 3_000 }),
      {
        terminalPromptPreflight: { runtimeId: 'new-runtime-before-restart' },
        orchestrationRequestId: '11111111-1111-4111-8111-111111111111',
        timeoutMs: 13_000
      }
    )
    expect(error).toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('cannot prove whether the prompt was delivered'),
      data: {
        deliveryOutcome: 'unknown',
        retrySafe: false,
        nextSteps: expect.arrayContaining([expect.stringContaining('Inspect the terminal output')])
      }
    })
    expect(log).not.toHaveBeenCalled()
  })
})

describe('terminal split CLI', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['up', 'left'])('refuses %s on an older host before splitting', async (direction) => {
    const call = vi.fn()
    const client = terminalClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-1',
      capabilities: []
    })
    await expect(
      TERMINAL_HANDLERS['terminal split']({
        flags: new Map([
          ['terminal', 'term-1'],
          ['direction', direction]
        ]),
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['right', 'vertical'],
    ['down', 'horizontal'],
    ['up', 'up'],
    ['left', 'left']
  ])('sends %s to the execution host as %s', async (direction, wireDirection) => {
    const call = vi.fn().mockResolvedValue({ result: { split: { handle: 'term-2' } } })
    const client = terminalClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-1',
      capabilities: [TERMINAL_SPLIT_DIRECTION_RUNTIME_CAPABILITY]
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await TERMINAL_HANDLERS['terminal split']({
      flags: new Map([
        ['terminal', 'term-1'],
        ['direction', direction]
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
    expect(call).toHaveBeenCalledWith('terminal.split', {
      terminal: 'term-1',
      direction: wireDirection,
      command: undefined
    })
  })

  it('retries the named split without requesting new placement or requiring directional support', async () => {
    const call = vi.fn().mockResolvedValue({ result: { split: { handle: 'term-2' } } })
    const client = terminalClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-1',
      capabilities: [TERMINAL_SPLIT_RETRY_RUNTIME_CAPABILITY]
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await TERMINAL_HANDLERS['terminal split']({
      flags: new Map([
        ['terminal', 'term-1'],
        ['direction', 'up'],
        ['retry-split', 'split-1']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
    expect(call).toHaveBeenCalledWith('terminal.split', {
      terminal: 'term-1',
      direction: undefined,
      command: undefined,
      retrySplit: 'split-1'
    })
  })
})
