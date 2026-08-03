import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileNativeChatFile,
  resolveMobileNativeChatWorktreePath
} from './mobile-native-chat-open-file'

describe('resolveMobileNativeChatWorktreePath', () => {
  it('resolves a chat path from the worktree root first', async () => {
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
    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:worktree',
        pathText: '/repo/src/app.ts'
      },
      { timeoutMs: 10_000 }
    )
  })

  it('navigates directly to the mobile preview for a resolved worktree file', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'worktree-file', relativePath: 'src/app.ts' }
      }
    })
    const pushPreviewRoute = vi.fn()

    await expect(
      openMobileNativeChatFile({
        client: { sendRequest } as unknown as RpcClient,
        hostId: 'host',
        worktreeId: 'worktree',
        worktreeName: 'Project',
        target: { pathText: '../repo/src/app.ts', line: 12, column: 3 },
        terminal: 'terminal',
        pushPreviewRoute
      })
    ).resolves.toBe(true)

    expect(sendRequest).toHaveBeenCalledOnce()
    expect(pushPreviewRoute).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host',
        worktreeId: 'worktree',
        worktreeName: 'Project',
        source: 'worktree',
        relativePath: 'src/app.ts',
        name: 'app.ts',
        line: '12',
        column: '3'
      }
    })
  })

  it('falls back to terminal cwd after a worktree-root miss', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { exists: false, isDirectory: false }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          exists: true,
          isDirectory: false,
          openTarget: { kind: 'worktree-file', relativePath: 'docs/readme.md' }
        }
      })

    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: 'docs/readme.md',
        terminal: 'terminal'
      })
    ).resolves.toBe('docs/readme.md')
    expect(sendRequest).toHaveBeenLastCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:worktree',
        pathText: 'docs/readme.md',
        terminal: 'terminal'
      },
      { timeoutMs: 10_000 }
    )
  })

  it('prefers the root file when the terminal cwd has an ambiguous match', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'worktree-file', relativePath: 'src/index.ts' }
      }
    })

    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'folder-workspace',
        pathText: 'src/index.ts',
        terminal: 'terminal-in-packages-app'
      })
    ).resolves.toBe('src/index.ts')

    expect(sendRequest).toHaveBeenCalledOnce()
    expect(sendRequest.mock.calls[0]?.[1]).not.toHaveProperty('terminal')
  })

  it('recovers an iOS-lowercased macOS home path after the original misses', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { exists: false, isDirectory: false }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { exists: false, isDirectory: false }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          exists: true,
          isDirectory: false,
          openTarget: {
            kind: 'worktree-file',
            relativePath: 'docs/native-chat-rendering-architecture.md'
          }
        }
      })

    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: '/users/me/project/docs/native-chat-rendering-architecture.md',
        terminal: 'terminal'
      })
    ).resolves.toBe('docs/native-chat-rendering-architecture.md')
    expect(sendRequest).toHaveBeenLastCalledWith(
      'files.resolveTerminalPath',
      {
        worktree: 'id:worktree',
        pathText: '/Users/me/project/docs/native-chat-rendering-architecture.md'
      },
      { timeoutMs: 10_000 }
    )
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

  it('does not navigate when resolution fails', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('connection interrupted'))
    const pushPreviewRoute = vi.fn()

    await expect(
      openMobileNativeChatFile({
        client: { sendRequest } as unknown as RpcClient,
        hostId: 'host',
        worktreeId: 'worktree',
        target: { pathText: 'src/app.ts', line: null, column: null },
        terminal: null,
        pushPreviewRoute
      })
    ).resolves.toBe(false)
    expect(pushPreviewRoute).not.toHaveBeenCalled()
  })

  it('does not reject when preview navigation fails', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'worktree-file', relativePath: 'src/app.ts' }
      }
    })

    await expect(
      openMobileNativeChatFile({
        client: { sendRequest } as unknown as RpcClient,
        hostId: 'host',
        worktreeId: 'worktree',
        target: { pathText: 'src/app.ts', line: null, column: null },
        terminal: null,
        pushPreviewRoute: () => {
          throw new Error('navigation failed')
        }
      })
    ).resolves.toBe(false)
  })

  it('rejects resolved paths outside the worktree', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        exists: true,
        isDirectory: false,
        openTarget: { kind: 'absolute-file', absolutePath: '/tmp/secret.txt', grantId: 'grant' }
      }
    })

    await expect(
      resolveMobileNativeChatWorktreePath({
        client: { sendRequest } as unknown as RpcClient,
        worktreeId: 'worktree',
        pathText: '/tmp/secret.txt',
        terminal: null
      })
    ).resolves.toBeNull()
  })
})
