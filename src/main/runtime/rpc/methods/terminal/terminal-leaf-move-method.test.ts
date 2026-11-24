import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods } from '../../core'
import { TERMINAL_METHODS } from './terminal'
import { moveLeafToNewTabOnRuntime } from './terminal-leaf-move-method'

function moveMethod() {
  const method = eraseRpcMethods(TERMINAL_METHODS).find(
    (candidate) => candidate.name === 'terminal.moveLeafToNewTab'
  )
  if (!method?.params) {
    throw new Error('terminal.moveLeafToNewTab method missing')
  }
  return { permission: method.permission, params: method.params }
}

function request(ptyId: string | null) {
  return {
    worktreeId: 'worktree-1',
    sourceTabId: 'tab-source',
    targetTabId: 'tab-target',
    leafId: '11111111-1111-4111-8111-111111111111',
    ptyId
  }
}

describe('terminal.moveLeafToNewTab', () => {
  it('registers the durable move contract', () => {
    const method = moveMethod()
    expect(method.permission).toBe('workspace')
    expect(method.params.parse(request('remote:env-1@@terminal-1'))).toEqual(
      request('remote:env-1@@terminal-1')
    )
    expect(() => method.params.parse({ ...request(null), sourceTabId: 'tab-target' })).toThrow()
  })

  it('resolves a Tauri remote PTY to the host PTY and maps the result back', async () => {
    const resolveLiveLeafForHandle = vi.fn(() => ({ ptyId: 'pty-host-1' }))
    const applyLayoutCommand = vi.fn(async () => ({
      ok: true as const,
      result: { tabId: 'tab-target', ptyId: 'pty-host-1' }
    }))

    const result = await moveLeafToNewTabOnRuntime(
      { resolveLiveLeafForHandle, applyLayoutCommand },
      request('remote:env-1@@terminal-1')
    )

    expect(resolveLiveLeafForHandle).toHaveBeenCalledWith('terminal-1')
    expect(applyLayoutCommand).toHaveBeenCalledWith({
      type: 'movePaneToNewTab',
      workspace: 'worktree-1',
      tabId: 'tab-source',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    expect(result).toEqual({
      status: 'moved',
      ptyId: 'remote:env-1@@terminal-1',
      tabId: 'tab-target'
    })
  })

  it('refuses a remote PTY that is no longer live instead of moving a stale binding', async () => {
    const applyLayoutCommand = vi.fn()
    const result = await moveLeafToNewTabOnRuntime(
      {
        resolveLiveLeafForHandle: vi.fn(() => null),
        applyLayoutCommand
      },
      request('remote:env-1@@terminal-1')
    )

    expect(result).toEqual({ status: 'refused', reason: 'pty_mismatch' })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })

  it.each([null, 'remote:malformed', 'pty-host-1'])(
    'refuses an unverifiable renderer binding %s before mutating the layout',
    async (ptyId) => {
      const applyLayoutCommand = vi.fn()
      const result = await moveLeafToNewTabOnRuntime(
        { resolveLiveLeafForHandle: vi.fn(), applyLayoutCommand },
        request(ptyId)
      )
      expect(result).toEqual({ status: 'refused', reason: 'pty_mismatch' })
      expect(applyLayoutCommand).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['tab_exists', 'target_tab_exists'],
    ['pane_in_other_tab', 'leaf_in_other_tab'],
    ['pty_mismatch', 'pty_mismatch']
  ] as const)('preserves host refusal %s', async (code, reason) => {
    const applyLayoutCommand = vi.fn(async () => ({ ok: false as const, code }))
    expect(
      await moveLeafToNewTabOnRuntime(
        {
          resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: 'pty-host-1' })),
          applyLayoutCommand
        },
        request('remote:env-1@@terminal-1')
      )
    ).toEqual({ status: 'refused', reason })
  })
})
