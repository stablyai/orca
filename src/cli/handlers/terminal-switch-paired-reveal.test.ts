import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'

const mocks = vi.hoisted(() => ({ revealPairedTerminalOnLocalDesktop: vi.fn() }))

vi.mock('../paired-terminal-desktop-reveal', () => ({
  revealPairedTerminalOnLocalDesktop: mocks.revealPairedTerminalOnLocalDesktop
}))

import { TERMINAL_HANDLERS } from './terminal'

function focusResponse(navigated: boolean) {
  return {
    id: 'req-focus',
    ok: true,
    result: { focus: { handle: 'term-1', tabId: 'tab-1', worktreeId: 'wt-1', navigated } },
    _meta: { runtimeId: 'runtime-1' }
  }
}

async function runSwitch(options: { call: RuntimeClient['call']; isRemote: boolean }) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const client = new RuntimeClient('/tmp/orca-switch-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(options.call)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(options.isRemote)
  await TERMINAL_HANDLERS['terminal switch']({
    flags: new Map([['terminal', 'term-1']]),
    client,
    cwd: '/tmp/worktree',
    json: true
  })
  return JSON.parse(String(log.mock.calls[0]?.[0]))
}

describe('terminal switch on a paired environment', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.revealPairedTerminalOnLocalDesktop.mockReset()
  })

  it.each([
    // The server's answer must not matter: a windowless one says false (#24688), a desktop true (#31073).
    ['a windowless server', false],
    ['a paired desktop with its own window', true]
  ])('moves the local desktop, not %s', async (_case, hostWouldNavigate) => {
    const call = vi.fn().mockResolvedValue(focusResponse(hostWouldNavigate))
    mocks.revealPairedTerminalOnLocalDesktop.mockResolvedValue(true)

    const printed = await runSwitch({ call, isRemote: true })

    expect(mocks.revealPairedTerminalOnLocalDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ isRemote: true }),
      'term-1'
    )
    expect(call).toHaveBeenCalledWith('terminal.focus', {
      terminal: 'term-1',
      navigation: 'caller'
    })
    expect(call).not.toHaveBeenCalledWith(
      'terminal.focus',
      expect.objectContaining({ navigation: 'host' })
    )
    expect(printed).toMatchObject({ ok: true, result: { focus: { navigated: true } } })
  })

  it.each([
    ['a windowless server', false],
    ['a paired desktop', true]
  ])(
    'falls back to %s navigating itself when no local desktop shows it',
    async (_case, navigated) => {
      const call = vi.fn().mockResolvedValue(focusResponse(navigated))
      mocks.revealPairedTerminalOnLocalDesktop.mockResolvedValue(false)

      const printed = await runSwitch({ call, isRemote: true })

      expect(mocks.revealPairedTerminalOnLocalDesktop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ isRemote: true }),
        'term-1'
      )
      expect(call).toHaveBeenCalledWith('terminal.focus', {
        terminal: 'term-1',
        navigation: 'host'
      })
      expect(printed).toMatchObject({ result: { focus: { navigated } } })
    }
  )

  it('leaves a local terminal to the host', async () => {
    const call = vi.fn().mockResolvedValue(focusResponse(false))

    const printed = await runSwitch({ call, isRemote: false })

    expect(mocks.revealPairedTerminalOnLocalDesktop).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('terminal.focus', { terminal: 'term-1', navigation: 'host' })
    expect(printed).toMatchObject({ result: { focus: { navigated: false } } })
  })
})
