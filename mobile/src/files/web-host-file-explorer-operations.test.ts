import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_FILE_DIRECTORY_LIMIT } from '../../../src/shared/mobile-web/file-operation-contract'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostFileExplorerOperations } from './web-host-file-explorer-operations'

describe('web host file explorer operations', () => {
  it('reads a bounded opaque directory and maps its presentation entries', async () => {
    const client = {
      fileDirectory: vi.fn().mockResolvedValue({
        workspaceId: 'workspace-page-1',
        relativePath: 'src',
        revision: 'a'.repeat(64),
        entries: [
          { name: 'components', isDirectory: true, isSymlink: false },
          { name: 'index.ts', isDirectory: false, isSymlink: true }
        ],
        truncated: false
      }),
      navigationReconnect: vi.fn()
    }
    const operations = webHostFileExplorerOperations(client as unknown as MobileWebBridgeClient)

    await expect(operations.readDirectory('workspace-page-1', 'src')).resolves.toEqual({
      kind: 'directory',
      entries: [
        { name: 'components', isDirectory: true, isSymlink: false },
        { name: 'index.ts', isDirectory: false, isSymlink: true }
      ],
      truncated: false
    })
    expect(client.fileDirectory).toHaveBeenCalledWith({
      workspaceId: 'workspace-page-1',
      relativePath: 'src',
      limit: MOBILE_WEB_FILE_DIRECTORY_LIMIT
    })
  })

  it('requests reconnect through the native shell boundary', async () => {
    const client = {
      fileDirectory: vi.fn(),
      navigationReconnect: vi.fn().mockResolvedValue(null)
    }
    const operations = webHostFileExplorerOperations(client as unknown as MobileWebBridgeClient)

    await operations.reconnect()

    expect(client.navigationReconnect).toHaveBeenCalledOnce()
  })
})
