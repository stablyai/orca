import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostFilePreviewOperations } from './web-host-file-preview-operations'

describe('web host file preview operations', () => {
  it('maps a bounded worktree Markdown read into the existing preview model', async () => {
    const client = bridgeClient()
    client.fileRead.mockResolvedValue({
      workspaceId: 'workspace-page-1',
      relativePath: 'README.md',
      content: '# Orca',
      truncated: false,
      byteLength: 6
    })
    const operations = webHostFilePreviewOperations(client as unknown as MobileWebBridgeClient)

    await expect(
      operations.load({
        source: 'worktree',
        worktreeId: 'workspace-page-1',
        relativePath: 'README.md'
      })
    ).resolves.toEqual({
      status: 'ready',
      kind: 'markdown',
      content: '# Orca',
      truncated: false,
      byteLength: 6
    })
    expect(client.fileRead).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      relativePath: 'README.md'
    })
  })

  it('rejects native terminal-artifact route authority without a bridge call', async () => {
    const client = bridgeClient()
    const operations = webHostFilePreviewOperations(client as unknown as MobileWebBridgeClient)

    await expect(
      operations.load({
        source: 'terminalArtifact',
        worktreeId: 'workspace-page-1',
        absolutePath: '/host/private/result.txt',
        grantId: 'native-grant'
      })
    ).resolves.toEqual({
      status: 'error',
      message: 'Reload preview before saving',
      reconnect: false
    })
    expect(client.fileRead).not.toHaveBeenCalled()
    expect(client.fileReadChunk).not.toHaveBeenCalled()
  })

  it('routes reconnect and external links through native capabilities', async () => {
    const client = bridgeClient()
    const operations = webHostFilePreviewOperations(client as unknown as MobileWebBridgeClient)

    await operations.reconnect()
    await operations.openExternalUrl('https://example.com')

    expect(client.navigationReconnect).toHaveBeenCalledOnce()
    expect(client.native.openExternal).toHaveBeenCalledWith('https://example.com')
  })
})

function bridgeClient() {
  return {
    fileRead: vi.fn(),
    fileReadChunk: vi.fn(),
    sourceControlDiff: vi.fn(),
    navigationReconnect: vi.fn().mockResolvedValue(null),
    native: {
      openExternal: vi.fn().mockResolvedValue(null)
    }
  }
}
