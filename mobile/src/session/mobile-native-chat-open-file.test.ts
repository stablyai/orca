import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileNativeChatFile,
  resolveMobileNativeChatWorktreePath
} from './mobile-native-chat-open-file'

describe('resolveMobileNativeChatWorktreePath', () => {
  it('resolves an absolute tool path to a worktree-relative open target', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'worktree-file', relativePath: 'src/app.ts' }
      }
    })
    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: '/repo/src/app.ts',
        terminal: 'terminal'
      })
    ).resolves.toBe('src/app.ts')
    expect(sendRequest).toHaveBeenCalledWith('files.resolveTerminalPath', {
      worktree: 'id:worktree',
      pathText: '/repo/src/app.ts',
      terminal: 'terminal'
    })
  })

  it('opens only the resolved worktree-relative target', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          exists: true,
          isDirectory: false,
          openTarget: { kind: 'worktree-file', relativePath: 'src/app.ts' }
        }
      })
      .mockResolvedValueOnce({ ok: true, result: {} })

    await openMobileNativeChatFile({
      client: { sendRequest } as unknown as RpcClient,
      worktreeId: 'worktree',
      pathText: '../repo/src/app.ts',
      terminal: 'terminal'
    })

    expect(sendRequest).toHaveBeenLastCalledWith('files.open', {
      worktree: 'id:worktree',
      relativePath: 'src/app.ts'
    })
  })

  it('resolves null when the resolve request rejects', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('Request timed out'))
    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: 'src/app.ts',
        terminal: null
      })
    ).resolves.toBeNull()
  })

  it('does not reject when the open request fails', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          exists: true,
          isDirectory: false,
          openTarget: { kind: 'worktree-file', relativePath: 'src/app.ts' }
        }
      })
      .mockRejectedValueOnce(new Error('connection interrupted'))

    await expect(
      openMobileNativeChatFile({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: 'src/app.ts',
        terminal: null
      })
    ).resolves.toBeUndefined()
  })
})
