import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type Handler = (event: { sender: unknown }, args: unknown) => Promise<boolean>

const { handlers, popoutSender } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  popoutSender: { id: 7 }
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
vi.mock('../ui', () => ({ isTrustedUIRenderer: () => false }))
vi.mock('../../window/dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))
vi.mock('../../window/terminal-popout-window', () => ({
  getTerminalPopoutPtyId: (sender: unknown) => (sender === popoutSender ? 'pty-a' : null)
}))

import { registerTerminalPreviewHandlers } from './terminal-preview'

describe('terminal pop-out preview trust', () => {
  const writeTerminalPreviewInput = vi.fn(async () => true)

  beforeEach(() => {
    handlers.clear()
    writeTerminalPreviewInput.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input channel reads only this member.
    registerTerminalPreviewHandlers({ writeTerminalPreviewInput } as unknown as OrcaRuntimeService)
  })

  it('types only into the PTY the pop-out was opened for', async () => {
    const input = handlers.get('terminalPreview:input')!

    await expect(input({ sender: popoutSender }, { ptyId: 'pty-a', data: 'ls\r' })).resolves.toBe(
      true
    )
    await expect(input({ sender: popoutSender }, { ptyId: 'pty-b', data: 'ls\r' })).resolves.toBe(
      false
    )
    await expect(input({ sender: { id: 8 } }, { ptyId: 'pty-a', data: 'ls\r' })).resolves.toBe(
      false
    )
    expect(writeTerminalPreviewInput.mock.calls).toEqual([['pty-a', 'ls\r']])
  })
})
