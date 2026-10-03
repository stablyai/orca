import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

afterEach(() => vi.restoreAllMocks())

describe('terminal set-pane-title', () => {
  it.each(['REVIEWER', ''])('sends an explicit title %j to the pane method', async (title) => {
    const parsed = parseArgs([
      'terminal',
      'set-pane-title',
      '--terminal',
      'term-1',
      '--title',
      title
    ])
    const client = new RuntimeClient()
    const call = vi.spyOn(client, 'call').mockResolvedValue({
      id: 'request',
      ok: true,
      result: {
        paneTitle: { handle: 'term-1', tabId: 'tab-1', leafId: 'leaf-1', title: title || null }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await TERMINAL_HANDLERS['terminal set-pane-title']({
      flags: parsed.flags,
      client,
      cwd: '/tmp',
      json: true
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('terminal.setPaneTitle', {
      terminal: 'term-1',
      title
    })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      result: { paneTitle: { title: title || null } }
    })
  })

  it.each([{ args: [] }, { args: ['--title'] }])(
    'refuses a missing title before resolving a terminal (%j)',
    async ({ args }) => {
      const client = new RuntimeClient()
      const call = vi.spyOn(client, 'call')
      const parsed = parseArgs(['terminal', 'set-pane-title', ...args])
      await expect(
        TERMINAL_HANDLERS['terminal set-pane-title']({
          flags: parsed.flags,
          client,
          cwd: '/tmp',
          json: true
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it('propagates an older host refusal without falling back to tab rename', async () => {
    const client = new RuntimeClient()
    const call = vi
      .spyOn(client, 'call')
      .mockRejectedValue(new RuntimeClientError('method_not_found', 'Unknown method'))
    await expect(
      TERMINAL_HANDLERS['terminal set-pane-title']({
        flags: new Map([
          ['terminal', 'term-1'],
          ['title', 'REVIEWER']
        ]),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toMatchObject({ code: 'method_not_found' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('documents a required pane-scoped title and explicit clearing', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'terminal set-pane-title')
    expect(spec?.usage).toContain('--title <text>')
    expect(spec?.usage).not.toContain('[--title')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(COMMAND_SPECS, ['terminal', 'set-pane-title'])
    const help = log.mock.calls.flat().join('\n')
    expect(help).toContain('Custom title for one pane (pass "" to reset)')
    expect(help).not.toContain('omit or pass')
  })
})
