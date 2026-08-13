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

describe('terminal split CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the old-host attribution bypass through the legacy-compatible env field', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'status.get'
        ? {
            result: {
              runtimeId: 'runtime-1',
              capabilities: ['terminal.attribution-removed.v1']
            }
          }
        : { result: { split: { handle: 'term-2', parentHandle: 'term-1' } } }
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal split']({
      flags: new Map([
        ['terminal', 'term-1'],
        ['direction', 'horizontal']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'status.get')
    expect(call).toHaveBeenNthCalledWith(
      2,
      'terminal.split',
      {
        terminal: 'term-1',
        direction: 'horizontal',
        command: undefined,
        env: { ORCA_ATTRIBUTION_BYPASS: '1' },
        envToDelete: ['ORCA_ENABLE_GIT_ATTRIBUTION']
      },
      { expectedRuntimeId: 'runtime-1' }
    )
  })

  it('refuses legacy hosts because renderer-owned splits discard environment fields', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { appVersion: '1.4.181', capabilities: ['mobile.tasks.v1'] }
    })

    await expect(
      TERMINAL_HANDLERS['terminal split']({
        flags: new Map([['terminal', 'term-1']]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'runtime_update_required',
      message: expect.stringContaining('Update the host and try again')
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).not.toHaveBeenCalledWith('terminal.split', expect.anything())
  })
})
