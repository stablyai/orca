import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktopCall: vi.fn(),
  desktopClient: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('./runtime-client', () => ({
  RuntimeClient: class {
    call = mocks.desktopCall
    constructor(...args: unknown[]) {
      mocks.desktopClient(...args)
    }
  }
}))
vi.mock('./runtime/environments', () => ({ resolveEnvironment: mocks.resolveEnvironment }))

import type { TerminalPaneRevealTarget } from '../shared/terminal-pane-reveal'
import type { RuntimeClient } from './runtime-client'
import { revealPairedTerminalOnLocalDesktop } from './paired-terminal-desktop-reveal'

const HANDLE = 'term_remote'
const shownTerminal = {
  handle: HANDLE,
  worktreeId: 'repo-1::/srv/app',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}

function pairedClient(environmentSelector: string | null) {
  const serverCall = vi.fn(async () => ({ ok: true, result: { terminal: shownTerminal } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reveal reads only these three members.
  const client = {
    environmentSelector,
    userDataPath: '/profile',
    call: serverCall
  } as unknown as RuntimeClient
  return { client, serverCall }
}

describe('revealPairedTerminalOnLocalDesktop', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.resolveEnvironment.mockReturnValue({ id: 'env/1' })
    mocks.desktopCall.mockImplementation(
      async (_method: string, params: TerminalPaneRevealTarget) => ({
        ok: true,
        result: { reveal: { ...params, navigated: true } }
      })
    )
  })

  it('routes a paired terminal reveal to the local desktop with its execution host', async () => {
    const { client, serverCall } = pairedClient('winpc')

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(true)

    expect(mocks.resolveEnvironment).toHaveBeenCalledWith('/profile', 'winpc')
    expect(serverCall).toHaveBeenCalledWith('terminal.show', { terminal: HANDLE })
    // null bypasses ambient remote selection so reveal reaches the local desktop.
    expect(mocks.desktopClient).toHaveBeenCalledWith('/profile', undefined, null, null)
    expect(mocks.desktopCall).toHaveBeenCalledWith('terminal.reveal', {
      worktreeId: shownTerminal.worktreeId,
      tabId: shownTerminal.tabId,
      leafId: shownTerminal.leafId,
      executionHostId: 'runtime:env%2F1'
    })
  })

  it('asks no desktop when the client is not talking to a paired environment', async () => {
    const { client, serverCall } = pairedClient(null)

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(false)

    expect(serverCall).not.toHaveBeenCalled()
    expect(mocks.desktopClient).not.toHaveBeenCalled()
  })

  it('asks no desktop when the server no longer knows the terminal', async () => {
    const { client, serverCall } = pairedClient('winpc')
    serverCall.mockRejectedValue(new Error('terminal_handle_stale'))

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(false)

    expect(mocks.desktopClient).not.toHaveBeenCalled()
  })

  it.each([
    ['no desktop is running here', new Error('runtime_unavailable')],
    ['the desktop predates terminal.reveal', new Error('method_not_found')]
  ])('keeps the server answer when %s', async (_case, error) => {
    const { client } = pairedClient('winpc')
    mocks.desktopCall.mockRejectedValue(error)

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(false)
  })

  it('keeps the server answer when the desktop does not know the workspace', async () => {
    const { client } = pairedClient('winpc')
    mocks.desktopCall.mockResolvedValue({ ok: true, result: { reveal: { navigated: false } } })

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(false)
  })
})
