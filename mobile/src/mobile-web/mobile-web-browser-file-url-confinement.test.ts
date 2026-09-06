import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSessionOperation } from './mobile-web-session-operations'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const WORKTREE_PATH = '/tmp/worktree-a'

/**
 * `session.createBrowser` is reachable from unprivileged page script, and the page it creates is
 * streamed back over `browser.screencast`. The shell is the trusted side of that call, so it — not
 * the page — decides which filesystem path a `file:` create may name.
 */
function resolveTerminalPathReply(pathText: string) {
  if (!pathText.startsWith(`${WORKTREE_PATH}/`)) {
    return { ok: true as const, result: { worktree: 'workspace-1', exists: false } }
  }
  return {
    ok: true as const,
    result: {
      worktree: 'workspace-1',
      relativePath: pathText.slice(WORKTREE_PATH.length + 1),
      absolutePath: pathText,
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'worktree-file',
        provider: 'local',
        relativePath: pathText.slice(WORKTREE_PATH.length + 1),
        absolutePath: pathText
      }
    }
  }
}

function createClient(overrides?: { provider?: 'local' | 'ssh' }) {
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'files.resolveTerminalPath') {
      const reply = resolveTerminalPathReply((params as { pathText: string }).pathText)
      if (overrides?.provider && 'openTarget' in reply.result && reply.result.openTarget) {
        reply.result.openTarget.provider = overrides.provider
      }
      return reply
    }
    if (method === 'browser.tabCreate') {
      return { ok: true, result: { browserPageId: 'page-1' } }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  return sendRequest
}

function operationArgs(sendRequest: RpcClient['sendRequest']) {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
  return {
    operation: 'createBrowser',
    requestId: 'R'.repeat(22),
    client: { sendRequest } as unknown as RpcClient,
    workspaceAuthority,
    browserAuthority: new MobileWebBrowserAuthority((length) => new Uint8Array(length)),
    nativeChatAuthority: new MobileWebNativeChatAuthority((length) => new Uint8Array(length)),
    workspaceId: workspaceAuthority.pageWorkspaceId('workspace-1')
  }
}

describe('mobile web createBrowser file: confinement', () => {
  it('refuses a file: URL the host does not resolve inside that workspace', async () => {
    const sendRequest = createClient()
    const args = operationArgs(sendRequest)
    await expect(
      executeMobileWebSessionOperation({
        ...args,
        payload: { workspaceId: args.workspaceId, url: 'file:///Users/dev/.ssh/id_rsa' }
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(sendRequest).not.toHaveBeenCalledWith('browser.tabCreate', expect.anything())
  })

  it('opens a workspace HTML artifact and forwards the host path, not the page string', async () => {
    const sendRequest = createClient()
    const args = operationArgs(sendRequest)
    await expect(
      executeMobileWebSessionOperation({
        ...args,
        payload: {
          workspaceId: args.workspaceId,
          url: `file://${WORKTREE_PATH}/build/report.html#frag`
        }
      })
    ).resolves.toMatchObject({ workspaceId: args.workspaceId })
    expect(sendRequest).toHaveBeenCalledWith('browser.tabCreate', {
      worktree: 'id:workspace-1',
      url: `file://${WORKTREE_PATH}/build/report.html`,
      activate: true
    })
  })

  it('refuses an SSH workspace file, which names a path on another machine', async () => {
    const sendRequest = createClient({ provider: 'ssh' })
    const args = operationArgs(sendRequest)
    await expect(
      executeMobileWebSessionOperation({
        ...args,
        payload: {
          workspaceId: args.workspaceId,
          url: `file://${WORKTREE_PATH}/build/report.html`
        }
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(sendRequest).not.toHaveBeenCalledWith('browser.tabCreate', expect.anything())
  })

  it('leaves an https create untouched', async () => {
    const sendRequest = createClient()
    const args = operationArgs(sendRequest)
    await executeMobileWebSessionOperation({
      ...args,
      payload: { workspaceId: args.workspaceId, url: 'https://example.com/' }
    })
    expect(sendRequest).not.toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      expect.anything(),
      expect.anything()
    )
    expect(sendRequest).toHaveBeenCalledWith('browser.tabCreate', {
      worktree: 'id:workspace-1',
      url: 'https://example.com/',
      activate: true
    })
  })
})
