import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

describe('terminal split initial ratio CLI', () => {
  afterEach(() => vi.restoreAllMocks())

  function splitClient(reachable = true, capabilities?: string[]) {
    const client = new RuntimeClient('/tmp/unused-split-ratio', 60_000, null, null)
    const call = vi.spyOn(client, 'call').mockResolvedValue({
      id: 'split',
      ok: true,
      result: { split: { handle: 'term-new', tabId: 'tab-1', paneRuntimeId: -1, leafId: 'new' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    const status = vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        app: { running: reachable, pid: reachable ? 1 : null },
        runtime: { state: 'ready', reachable, runtimeId: 'runtime-1', capabilities },
        graph: { state: 'ready' }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return { client, call, status }
  }

  it('omits the ratio key and status call on the legacy split route, including paired transport', async () => {
    const { client, call, status } = splitClient()
    vi.spyOn(client, 'isRemote', 'get').mockReturnValue(true)
    await TERMINAL_HANDLERS['terminal split']({
      flags: new Map([['terminal', 'term-1']]),
      client,
      cwd: '/tmp',
      json: true
    })
    expect(status).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.split', {
      terminal: 'term-1',
      direction: undefined,
      command: undefined
    })
  })

  it('preflights a supplied ratio before forwarding it to the split RPC', async () => {
    const { client, call, status } = splitClient(true, [
      TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY
    ])
    await TERMINAL_HANDLERS['terminal split']({
      flags: new Map([
        ['terminal', 'term-1'],
        ['ratio', '0.85']
      ]),
      client,
      cwd: '/tmp',
      json: true
    })
    expect(status).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.split', {
      terminal: 'term-1',
      direction: undefined,
      command: undefined,
      ratio: 0.85
    })
    expect(status.mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0])
  })

  it.each([
    '',
    true,
    false,
    '0',
    '1',
    '-0.1',
    '1.1',
    'NaN',
    'Infinity',
    '-Infinity',
    'text',
    '0.85x'
  ])(
    'rejects explicit invalid ratio %s before status, selector or mutation calls',
    async (value) => {
      const { client, call, status } = splitClient()
      await expect(
        TERMINAL_HANDLERS['terminal split']({
          flags: new Map<string, string | boolean>([['ratio', value]]),
          client,
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(status).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('refuses paired transport before status or selector calls', async () => {
    const { client, call, status } = splitClient()
    vi.spyOn(client, 'isRemote', 'get').mockReturnValue(true)
    await expect(
      TERMINAL_HANDLERS['terminal split']({
        flags: new Map([['ratio', '0.85']]),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(status).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    [false, undefined, 'runtime_unavailable'],
    [true, undefined, 'incompatible_runtime'],
    [true, [], 'incompatible_runtime']
  ] as const)(
    'refuses unavailable or older runtimes without resolving a terminal',
    async (reachable, capabilities, code) => {
      const { client, call, status } = splitClient(
        reachable,
        capabilities ? [...capabilities] : undefined
      )
      await expect(
        TERMINAL_HANDLERS['terminal split']({
          flags: new Map([['ratio', '0.85']]),
          client,
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code })
      expect(status).toHaveBeenCalledOnce()
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('documents the first-pane fraction and eligible local desktop scope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(COMMAND_SPECS, ['terminal', 'split'])
    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('--ratio <fraction>')
    expect(help).toContain('greater than 0 and less than 1')
    expect(help).toContain('native local PTY')
    expect(help).toContain('existing first pane')
  })
})
