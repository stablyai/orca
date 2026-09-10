import { describe, expect, it, vi } from 'vitest'
import {
  readResolvedTerminalHandle,
  resolveMobileMaestroTerminalHandle,
  resolveMaestroTerminalPaneKey
} from './mobile-maestro-terminal-resolution'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

describe('resolveMaestroTerminalPaneKey', () => {
  it('combines the projected terminal tab and leaf identities', () => {
    expect(resolveMaestroTerminalPaneKey('terminal-tab', LEAF_ID)).toBe(`terminal-tab:${LEAF_ID}`)
  })

  it('preserves a matching stable pane key', () => {
    expect(resolveMaestroTerminalPaneKey('terminal-tab', `terminal-tab:${LEAF_ID}`)).toBe(
      `terminal-tab:${LEAF_ID}`
    )
  })

  it('rejects a pane key owned by another tab', () => {
    expect(resolveMaestroTerminalPaneKey('terminal-tab', `other-tab:${LEAF_ID}`)).toBeNull()
  })
})

describe('readResolvedTerminalHandle', () => {
  it('reads the nested terminal.resolvePane contract', () => {
    expect(readResolvedTerminalHandle({ terminal: { handle: 'terminal-live' } })).toBe(
      'terminal-live'
    )
  })

  it('rejects the old flat response assumption', () => {
    expect(readResolvedTerminalHandle({ terminal: 'terminal-live' })).toBeNull()
  })
})

describe('resolveMobileMaestroTerminalHandle', () => {
  it('uses the exact pane resolution when the host has it', async () => {
    const sendRequest = vi.fn(async () => ({
      ok: true as const,
      result: { terminal: { handle: 'terminal-live' } }
    }))

    await expect(
      resolveMobileMaestroTerminalHandle({
        client: { sendRequest },
        terminalTabId: 'terminal-tab',
        paneKey: LEAF_ID,
        worktreeId: 'worktree-1',
        sessionId: 'pty-1'
      })
    ).resolves.toBe('terminal-live')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('recovers a restored pane from its unique PTY identity', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { message: 'terminal_not_found' } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          terminals: [
            {
              handle: 'terminal-restored',
              ptyId: 'pty-1',
              tabId: 'terminal-tab',
              leafId: LEAF_ID
            }
          ]
        }
      })

    await expect(
      resolveMobileMaestroTerminalHandle({
        client: { sendRequest },
        terminalTabId: 'terminal-tab',
        paneKey: LEAF_ID,
        worktreeId: 'worktree-1',
        sessionId: 'pty-1'
      })
    ).resolves.toBe('terminal-restored')
    expect(sendRequest).toHaveBeenLastCalledWith('terminal.list', {
      worktree: 'id:worktree-1',
      includeVisualLayouts: false
    })
  })

  it('does not guess between duplicate PTY candidates', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { message: 'terminal_not_found' } })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          terminals: [
            { handle: 'terminal-a', ptyId: 'pty-1', tabId: 'tab-a', leafId: LEAF_ID },
            { handle: 'terminal-b', ptyId: 'pty-1', tabId: 'tab-b', leafId: LEAF_ID }
          ]
        }
      })

    await expect(
      resolveMobileMaestroTerminalHandle({
        client: { sendRequest },
        terminalTabId: 'terminal-tab',
        paneKey: LEAF_ID,
        worktreeId: null,
        sessionId: 'pty-1'
      })
    ).resolves.toBeNull()
  })
})
