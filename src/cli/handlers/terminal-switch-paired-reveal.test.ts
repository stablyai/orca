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

  it('shows the terminal in the local desktop when the windowless server cannot (#24688)', async () => {
    const call = vi.fn().mockResolvedValue(focusResponse(false))
    mocks.revealPairedTerminalOnLocalDesktop.mockResolvedValue(true)

    const printed = await runSwitch({ call, isRemote: true })

    expect(call).toHaveBeenCalledWith('terminal.focus', { terminal: 'term-1', navigation: 'host' })
    expect(mocks.revealPairedTerminalOnLocalDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ isRemote: true }),
      'term-1'
    )
    expect(printed).toMatchObject({ ok: true, result: { focus: { navigated: true } } })
  })

  it('keeps navigated false when no local desktop shows that environment', async () => {
    const call = vi.fn().mockResolvedValue(focusResponse(false))
    mocks.revealPairedTerminalOnLocalDesktop.mockResolvedValue(false)

    const printed = await runSwitch({ call, isRemote: true })

    expect(mocks.revealPairedTerminalOnLocalDesktop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ isRemote: true }),
      'term-1'
    )
    expect(printed).toMatchObject({ result: { focus: { navigated: false } } })
  })

  it.each([
    ['a local terminal the host could not navigate to', false, false],
    ['a remote host that navigated itself', true, true]
  ])('leaves %s alone', async (_case, isRemote, navigated) => {
    const call = vi.fn().mockResolvedValue(focusResponse(navigated))

    const printed = await runSwitch({ call, isRemote })

    expect(mocks.revealPairedTerminalOnLocalDesktop).not.toHaveBeenCalled()
    expect(printed).toMatchObject({ result: { focus: { navigated } } })
  })
})
