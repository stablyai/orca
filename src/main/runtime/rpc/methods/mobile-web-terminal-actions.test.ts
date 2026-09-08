import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_TERMINAL_ACTION_METHODS } from './mobile-web-terminal-actions'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'

const [action] = MOBILE_WEB_TERMINAL_ACTION_METHODS
function fixture(worktree = 'folder:workspace') {
  const tab = { id: 'tab', type: 'terminal', status: 'ready', terminal: 'private-terminal' }
  const runtime = {
    listMobileSessionTabs: vi
      .fn()
      .mockResolvedValue({ worktree, publicationEpoch: 'epoch', snapshotVersion: 1, tabs: [tab] }),
    registerSubscriptionCleanup: vi.fn(),
    renameTerminal: vi.fn().mockResolvedValue({ handle: 'private-terminal' }),
    clearTerminalBuffer: vi.fn().mockResolvedValue({ handle: 'private-terminal' }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'remote-pty' }),
    updateMobileSubscriberViewport: vi.fn(),
    markMobileActor: vi.fn(),
    setMobileDisplayMode: vi.fn(),
    applyMobileDisplayMode: vi.fn(),
    getLayout: vi.fn()
  }
  const context = {
    runtime,
    connectionId: 'connection',
    clientId: 'authenticated',
    pairedDeviceId: 'device'
  } as unknown as RpcContext
  const scope = { worktree: `id:${worktree}`, tabId: 'tab', timeoutMs: 15_000 }
  return { context, runtime, scope, tab }
}

afterEach(() => vi.useRealTimers())

describe('host-owned terminal metadata', () => {
  it.each(['folder:workspace', 'ssh-workspace'])(
    'applies %s actions through the owning runtime and ignores a forged terminal field',
    async (workspace) => {
      const f = fixture(workspace)
      for (const method of ['terminal.rename', 'terminal.clearBuffer']) {
        expect(
          await action.handler(
            { ...f.scope, method, fields: { title: 'Build', terminal: 'forged' } },
            f.context
          )
        ).toEqual({ applied: true })
      }
      expect(f.runtime.listMobileSessionTabs).toHaveBeenCalledWith(f.scope.worktree, 'device')
      expect(f.runtime.renameTerminal).toHaveBeenCalledWith('private-terminal', 'Build')
      expect(f.runtime.clearTerminalBuffer).toHaveBeenCalledWith('private-terminal')
    }
  )
  it('uses the authenticated mobile actor and existing viewport driver', async () => {
    const f = fixture()
    await action.handler(
      {
        ...f.scope,
        method: 'terminal.setDisplayMode',
        fields: { mode: 'auto', viewport: { cols: 90, rows: 30 }, client: { id: 'forged' } }
      },
      f.context
    )
    expect(f.runtime.updateMobileSubscriberViewport).toHaveBeenCalledWith(
      'remote-pty',
      'authenticated',
      { cols: 90, rows: 30 }
    )
    expect(f.runtime.markMobileActor).toHaveBeenCalledWith('remote-pty', 'authenticated')
    expect(f.runtime.applyMobileDisplayMode).toHaveBeenCalledWith('remote-pty')
  })
  it('refuses missing, nonready and cross-workspace tabs before mutation', async () => {
    const f = fixture()
    const params = { ...f.scope, method: 'terminal.clearBuffer', fields: {} }
    for (const tabs of [[], [{ ...f.tab, status: 'pending-handle' }]]) {
      f.runtime.listMobileSessionTabs.mockResolvedValue({ worktree: 'folder:workspace', tabs })
      await expect(action.handler(params, f.context)).rejects.toThrow('selector_not_found')
    }
    f.runtime.listMobileSessionTabs.mockResolvedValue({
      worktree: 'folder:other',
      tabs: [f.tab]
    })
    await expect(action.handler(params, f.context)).rejects.toThrow('selector_not_found')
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
  })
  it('does not dispatch after disconnect during identity lookup, and never retries handler failures', async () => {
    const f = fixture()
    const params = { ...f.scope, method: 'terminal.clearBuffer', fields: {} }
    const controller = new AbortController()
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      controller.abort()
      return {
        worktree: 'folder:workspace',
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        tabs: [f.tab]
      }
    })
    await expect(
      action.handler(params, { ...f.context, signal: controller.signal })
    ).rejects.toThrow('runtime_unavailable')
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
    f.runtime.clearTerminalBuffer.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(action.handler(params, f.context)).rejects.toThrow('lost acknowledgement')
    expect(f.runtime.clearTerminalBuffer).toHaveBeenCalledOnce()
  })
  it('expires a delayed identity lookup without changing the terminal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.runtime.listMobileSessionTabs.mockImplementationOnce(async () => {
      vi.setSystemTime(20_000)
      return {
        worktree: 'folder:workspace',
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        tabs: [f.tab]
      }
    })
    await expect(
      action.handler({ ...f.scope, method: 'terminal.clearBuffer', fields: {} }, f.context)
    ).rejects.toThrow('runtime_unavailable')
    expect(f.runtime.clearTerminalBuffer).not.toHaveBeenCalled()
  })
  it('reaches a mobile-scope socket without a page session of its own', () => {
    expect(isMobileWebHostRpcMethod('mobileWeb.terminal.action')).toBe(true)
  })
})
