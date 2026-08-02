import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the default close RPC unchanged', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
    const parsed = parseArgs(['terminal', 'close', '--terminal', 'term-1', '--tab'])
    const call = vi.fn().mockResolvedValue({
      result: {
        close: {
          handle: 'term-1',
          tabId: 'tab-1',
          closeMode: 'tab',
          ptyKilled: false
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(parsed.flags.get('tab')).toBe(true)
    expect(call).toHaveBeenCalledWith('terminal.closeTab', { terminal: 'term-1' })
  })

  it('documents that --tab waits for durable persistence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'close'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('orca terminal close [--terminal <handle>] [--tab] [--json]')
    expect(help).toContain('durable persistence')
  })
})

describe('terminal create CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function invoke(
    flags: Map<string, string | boolean>,
    call = vi.fn().mockResolvedValue({
      result: { terminal: { handle: 'term-1', worktreeId: 'worktree-1', title: 'Codex' } }
    })
  ) {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return {
      call,
      promise: TERMINAL_HANDLERS['terminal create']({
        flags,
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    }
  }

  it('keeps ordinary terminal creation on the legacy RPC by default', async () => {
    const { call, promise } = invoke(
      new Map<string, string | boolean>([
        ['worktree', 'id:worktree-1'],
        ['command', 'codex']
      ])
    )

    await promise

    expect(call).toHaveBeenCalledWith('terminal.create', {
      worktree: 'id:worktree-1',
      command: 'codex',
      title: undefined,
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('routes explicit controlled coordinator creation through the agent-session RPC', async () => {
    const { call, promise } = invoke(
      new Map<string, string | boolean>([
        ['worktree', 'id:worktree-1'],
        ['controlled-codex-coordinator', true]
      ])
    )

    await promise

    expect(call).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('terminal.createAgentSession', {
      clientOperationId: expect.stringMatching(/^\d+-[a-f0-9]{32}$/),
      worktree: 'id:worktree-1',
      agent: 'codex',
      presentation: 'background',
      controlledCoordinator: true
    })
  })

  it.each(['command', 'title'])(
    'rejects controlled creation with --%s before RPC',
    async (flag) => {
      const { call, promise } = invoke(
        new Map<string, string | boolean>([
          ['worktree', 'id:worktree-1'],
          ['controlled-codex-coordinator', true],
          [flag, 'caller override']
        ])
      )

      await expect(promise).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('does not fall back to an unmanaged terminal after a controlled RPC failure', async () => {
    const failure = new Error('controlled Codex launch is disabled')
    const call = vi.fn().mockRejectedValue(failure)
    const { promise } = invoke(
      new Map<string, string | boolean>([
        ['worktree', 'id:worktree-1'],
        ['controlled-codex-coordinator', true]
      ]),
      call
    )

    await expect(promise).rejects.toBe(failure)
    expect(call).toHaveBeenCalledOnce()
    expect(call.mock.calls[0]?.[0]).toBe('terminal.createAgentSession')
  })

  it('parses and documents the controlled coordinator opt-in', () => {
    const parsed = parseArgs(['terminal', 'create', '--controlled-codex-coordinator'])
    expect(parsed.flags.get('controlled-codex-coordinator')).toBe(true)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(COMMAND_SPECS, ['terminal', 'create'])
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'orca terminal create --worktree active --controlled-codex-coordinator --json'
    )
  })
})
