import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktopCall: vi.fn(),
  desktopClient: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../runtime/client', () => ({
  RuntimeClient: class {
    call = mocks.desktopCall
    constructor(...args: unknown[]) {
      mocks.desktopClient(...args)
    }
  }
}))
vi.mock('../runtime/environments', () => ({ resolveEnvironment: mocks.resolveEnvironment }))

import type { TerminalPaneRevealTarget } from '../../shared/workspace-layout/terminal-surfaces/terminal-pane-reveal'
import type { RuntimeClient } from '../runtime/client'
import { revealPairedTerminalOnLocalDesktop } from './paired-terminal-desktop-reveal'

const HANDLE = 'term_remote'
const shownTerminal = {
  handle: HANDLE,
  worktreeId: 'repo-1::/srv/app',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111'
}

function pairedClient() {
  const serverCall = vi.fn(async () => ({ ok: true, result: { terminal: shownTerminal } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reveal reads only these three members.
  const client = {
    environmentSelector: 'winpc',
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

  it('bounds both the paired host and the local desktop before the host fallback', async () => {
    const { client, serverCall } = pairedClient()

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(true)

    expect(serverCall).toHaveBeenCalledWith(
      'terminal.show',
      { terminal: HANDLE },
      { timeoutMs: 12_000 }
    )
    // null bypasses ambient remote selection so reveal reaches the local desktop; 12 s bounds a stalled one.
    expect(mocks.desktopClient).toHaveBeenCalledWith('/profile', 12_000, null, null)
  })

  it('asks no desktop when the paired host is too slow to show the terminal', async () => {
    const { client, serverCall } = pairedClient()
    serverCall.mockRejectedValue(new Error('request_timeout'))

    await expect(revealPairedTerminalOnLocalDesktop(client, HANDLE)).resolves.toBe(false)

    expect(mocks.desktopClient).not.toHaveBeenCalled()
  })
})
