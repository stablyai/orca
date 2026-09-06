import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebFileOpenOperation } from './mobile-web-file-open-operation'

describe('mobile web file open operation', () => {
  it('activates an opened edit tab beyond the mobile snapshot limit', async () => {
    const tabs = [
      { id: 'terminal', type: 'terminal', isActive: true },
      ...Array.from({ length: 199 }, (_, index) => ({
        id: `filler-${index}`,
        type: 'file',
        mode: 'edit',
        relativePath: `src/filler-${index}.ts`
      })),
      {
        id: 'target-edit',
        type: 'file',
        mode: 'edit',
        relativePath: 'src/target.ts'
      }
    ]
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'session.tabs.list') {
          return { ok: true, result: { tabs } }
        }
        if (method === 'session.tabs.activate') {
          return { ok: true, result: { activeTabId: 'target-edit' } }
        }
        return { ok: true, result: null }
      })
    } as unknown as RpcClient

    await expect(
      executeMobileWebFileOpenOperation({
        client,
        hostWorkspaceId: 'workspace-1',
        relativePath: 'src/target.ts',
        assertCurrent: () => {}
      })
    ).resolves.toBeNull()

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'files.open', {
      worktree: 'id:workspace-1',
      relativePath: 'src/target.ts'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(3, 'session.tabs.activate', {
      worktree: 'id:workspace-1',
      tabId: 'target-edit',
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  })

  it('does not activate after workspace authority changes', async () => {
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'session.tabs.list') {
          return {
            ok: true,
            result: {
              tabs: [
                {
                  id: 'target-edit',
                  type: 'file',
                  mode: 'edit',
                  relativePath: 'src/target.ts'
                }
              ]
            }
          }
        }
        return { ok: true, result: null }
      })
    } as unknown as RpcClient
    let authorityChecks = 0

    await expect(
      executeMobileWebFileOpenOperation({
        client,
        hostWorkspaceId: 'folder-workspace',
        relativePath: 'src/target.ts',
        assertCurrent: () => {
          authorityChecks += 1
          if (authorityChecks === 2) {
            throw new Error('workspace_binding_stale')
          }
        }
      })
    ).rejects.toThrow('workspace_binding_stale')

    expect(client.sendRequest).not.toHaveBeenCalledWith('session.tabs.activate', expect.anything())
  })
})
