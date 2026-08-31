import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode

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

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
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

  it('explains that Structured Chat blocked a refused send and how to recover', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: false,
          bytesWritten: 0,
          agentSessionRefusal: {
            code: 'agent_session_conflict',
            sessionId: 'session-1',
            ownerRuntimeKind: 'native',
            handoffStage: null,
            ownerPid: 4242,
            runtimeFence: 7
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Structured Chat.*Switch it to Terminal.*orca terminal send/s)
    )
    expect(process.exitCode).toBe(1)
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
