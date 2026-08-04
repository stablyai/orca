import { Readable } from 'node:stream'
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

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    restoreStdin()
  })

  let restoreStdin = (): void => {}

  function stubStdin(payload: string): void {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    const stream = Readable.from([Buffer.from(payload, 'utf8')]) as unknown as NodeJS.ReadStream
    stream.isTTY = false
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    restoreStdin = () => {
      if (original) {
        Object.defineProperty(process, 'stdin', original)
      }
      restoreStdin = () => {}
    }
  }

  async function send(argv: string[]): Promise<ReturnType<typeof vi.fn>> {
    const call = vi.fn().mockResolvedValue({ result: { send: { handle: 'term-1' } } })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await TERMINAL_HANDLERS['terminal send']({
      flags: parseArgs(argv).flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    return call
  }

  it('takes the payload from stdin, quotes intact', async () => {
    // Why: this exact payload is destroyed in argv on WSL — the bridge cannot carry an ASCII
    // double quote — so stdin is the only lossless route for it.
    const payload = 'say "hello" now'
    stubStdin(payload)

    const call = await send(['terminal', 'send', '--terminal', 'term-1', '--text-stdin', '--enter'])

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: payload, enter: true })
    )
  })

  it('preserves a multi-line stdin payload verbatim', async () => {
    const payload = 'first "line"\nsecond \\ line\n'
    stubStdin(payload)

    const call = await send(['terminal', 'send', '--terminal', 'term-1', '--text-stdin'])

    expect(call).toHaveBeenCalledWith('terminal.send', expect.objectContaining({ text: payload }))
  })

  it('rejects --text together with --text-stdin', async () => {
    stubStdin('from stdin')

    await expect(
      send(['terminal', 'send', '--terminal', 'term-1', '--text', 'inline', '--text-stdin'])
    ).rejects.toThrow('Use either --text or --text-stdin, not both')
  })

  it('leaves the --text path unchanged', async () => {
    const call = await send(['terminal', 'send', '--terminal', 'term-1', '--text', 'npm test'])

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: 'npm test', enter: false, interrupt: false })
    )
  })

  it('sends no text when neither flag is given', async () => {
    const call = await send(['terminal', 'send', '--terminal', 'term-1', '--interrupt'])

    expect(call).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: undefined, interrupt: true })
    )
  })

  it('documents the stdin route in help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'send'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('--text-stdin')
    expect(help).toContain('PowerShell bridge')
  })
})
