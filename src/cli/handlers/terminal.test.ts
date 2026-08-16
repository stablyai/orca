import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { formatCommandHelp, printHelp } from '../help'
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
    expect(help).toContain(
      'orca terminal close [--terminal <handle> | --terminal pty:<ptyId>] [--tab] [--json]'
    )
    expect(help).toContain('durable persistence')
  })
})

describe('terminal selector help', () => {
  it.each(['show', 'read', 'send', 'wait', 'switch', 'close', 'rename', 'split'])(
    'documents the stable pty selector for terminal %s',
    (command) => {
      const spec = COMMAND_SPECS.find(
        (candidate) => candidate.path[0] === 'terminal' && candidate.path[1] === command
      )

      expect(spec).toBeDefined()
      expect(spec!.usage).toContain('pty:<ptyId>')
      expect(formatCommandHelp(spec!)).toContain(
        '--terminal <selector> Runtime handle or stable pty:<ptyId>'
      )
    }
  )

  it('keeps orchestration terminal flags handle-only', () => {
    const spec = COMMAND_SPECS.find(
      (candidate) => candidate.path[0] === 'orchestration' && candidate.path[1] === 'check'
    )

    expect(spec).toBeDefined()
    expect(formatCommandHelp(spec!)).not.toContain('pty:<ptyId>')
  })

  it('keeps root terminal usages synchronized', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, [])

    const help = String(log.mock.calls[0]?.[0])
    for (const command of ['show', 'read', 'send', 'wait', 'split', 'switch', 'close']) {
      expect(help).toMatch(new RegExp(`orca terminal ${command} .*pty:<ptyId>`))
    }
  })
})
