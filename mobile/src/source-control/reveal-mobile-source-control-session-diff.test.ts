import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { revealMobileSourceControlSessionDiff } from './reveal-mobile-source-control-session-diff'

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientWith(sendRequest: RpcClient['sendRequest']): Pick<RpcClient, 'sendRequest'> {
  return { sendRequest }
}

function options(sendRequest: RpcClient['sendRequest']) {
  return {
    client: clientWith(sendRequest),
    worktreeId: 'worktree-1',
    relativePath: 'src/target.ts',
    tabMode: 'diff' as const,
    staged: true
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('revealMobileSourceControlSessionDiff', () => {
  it('activates the requested file when its diff tab is already open', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({
          activeTabId: 'agent-tab',
          tabs: [
            { id: 'agent-tab', type: 'terminal' },
            {
              id: 'other-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/other.ts'
            },
            {
              id: 'target-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'target-diff' }))

    await expect(revealMobileSourceControlSessionDiff(options(sendRequest))).resolves.toBe(
      'revealed'
    )
    expect(sendRequest).toHaveBeenNthCalledWith(2, 'session.tabs.activate', {
      worktree: 'id:worktree-1',
      tabId: 'target-diff',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  })

  it('selects the staged diff when both versions of a file are open', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              id: 'unstaged-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'unstaged',
              relativePath: 'src/target.ts'
            },
            {
              id: 'staged-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'staged-diff' }))

    await expect(revealMobileSourceControlSessionDiff(options(sendRequest))).resolves.toBe(
      'revealed'
    )
    expect(sendRequest).toHaveBeenLastCalledWith(
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'staged-diff' })
    )
  })

  it('waits for the requested diff source instead of activating the other one', async () => {
    vi.useFakeTimers()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              id: 'unstaged-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'unstaged',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              id: 'staged-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'staged-diff' }))

    const reveal = revealMobileSourceControlSessionDiff(options(sendRequest))
    await vi.advanceTimersByTimeAsync(300)

    await expect(reveal).resolves.toBe('revealed')
    expect(sendRequest).toHaveBeenLastCalledWith(
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'staged-diff' })
    )
  })

  it('activates a legacy edit tab when opening a diff falls back to files.open', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              id: 'stale-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/target.ts'
            },
            {
              id: 'target-edit',
              type: 'file',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'target-edit' }))

    await expect(
      revealMobileSourceControlSessionDiff({ ...options(sendRequest), tabMode: 'edit' })
    ).resolves.toBe('revealed')
    expect(sendRequest).toHaveBeenLastCalledWith(
      'session.tabs.activate',
      expect.objectContaining({ tabId: 'target-edit' })
    )
  })

  it('retries until the opened diff appears in the session snapshot', async () => {
    vi.useFakeTimers()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce(success({ tabs: [{ id: 'agent-tab', type: 'terminal' }] }))
      .mockResolvedValueOnce(
        success({
          tabs: [
            {
              id: 'target-diff',
              type: 'file',
              mode: 'diff',
              diffSource: 'staged',
              relativePath: 'src/target.ts'
            }
          ]
        })
      )
      .mockResolvedValueOnce(success({ activeTabId: 'target-diff' }))

    const reveal = revealMobileSourceControlSessionDiff(options(sendRequest))
    await vi.advanceTimersByTimeAsync(300)

    await expect(reveal).resolves.toBe('revealed')
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })

  it('delegates to the mounted session when the dock callback is available', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    const onOpenedFileDiff = vi.fn()

    await expect(
      revealMobileSourceControlSessionDiff({
        ...options(sendRequest),
        onOpenedFileDiff
      })
    ).resolves.toBe('revealed')

    expect(onOpenedFileDiff).toHaveBeenCalledWith('src/target.ts')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('cancels route-owned polling after the source-control screen unmounts', async () => {
    let current = true
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async () => {
      current = false
      return success({ tabs: [] })
    })

    await expect(
      revealMobileSourceControlSessionDiff({
        ...options(sendRequest),
        isCurrent: () => current
      })
    ).resolves.toBe('cancelled')
    expect(sendRequest).toHaveBeenCalledOnce()
  })
})
