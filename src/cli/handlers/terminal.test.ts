import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import type * as FormatModule from '../format'
import { printResult } from '../format'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import type * as SelectorsModule from '../selectors'
import { TERMINAL_HANDLERS } from './terminal'

vi.mock('../selectors', async () => {
  const actual = await vi.importActual<typeof SelectorsModule>('../selectors')
  return {
    ...actual,
    getBrowserWorktreeSelector: vi.fn(async () => 'active')
  }
})

vi.mock('../format', async () => {
  const actual = await vi.importActual<typeof FormatModule>('../format')
  return { ...actual, printResult: vi.fn() }
})

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

describe('terminal create CLI contract', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['whitespace-only', '   ']
  ])('fails closed for a %s terminal handle', async (_label, handle) => {
    vi.mocked(printResult).mockClear()
    const call = vi.fn().mockResolvedValue({
      result: {
        terminal: {
          handle,
          worktreeId: 'wt-1',
          title: null
        }
      }
    })

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: new Map([['worktree', 'active']]),
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: process.cwd(),
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('without a terminal handle')
    })
    expect(printResult).not.toHaveBeenCalled()
  })

  it('prints a successful create response with a valid handle', async () => {
    vi.mocked(printResult).mockClear()
    const result = {
      result: {
        terminal: {
          handle: 'term-created',
          worktreeId: 'wt-1',
          title: null
        }
      }
    }
    const call = vi.fn().mockResolvedValue(result)

    await TERMINAL_HANDLERS['terminal create']({
      flags: new Map([['worktree', 'active']]),
      client: { call, isRemote: false } as unknown as RuntimeClient,
      cwd: process.cwd(),
      json: true
    })

    expect(printResult).toHaveBeenCalledWith(result, true, expect.any(Function))
  })
})

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks combined text and Enter as an agent prompt candidate', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 7 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: 'review',
      enter: true,
      interrupt: false,
      agentPrompt: true,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('keeps text-only and bare Enter sends as direct terminal input', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 1 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'x']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'terminal.send', {
      terminal: 'term-1',
      text: 'x',
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'term-1',
      text: undefined,
      enter: true,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })
})
