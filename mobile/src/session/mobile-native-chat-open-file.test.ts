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
})
