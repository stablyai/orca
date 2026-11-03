import type * as WorktreeScanCacheModule from '../git/worktree-scan-cache'
import type * as WorktreeListingModule from '../git/worktree-listing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree-scan-cache', async (importOriginal) => {
  const facade = await vi.importMock<typeof WorktreeScanCacheModule>('../git/worktree')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../git/worktree-listing', async (importOriginal) => {
  const facade = await vi.importMock<typeof WorktreeListingModule>('../git/worktree')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('serves worktree.ps from the runtime summary builder', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore({ isUnread: true }) as never)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello\n', 555)

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_ps',
      authToken: metadata!.authToken,
      method: 'worktree.ps'
    })

    expect(response).toMatchObject({
      id: 'req_ps',
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'repo-1::/tmp/worktree-a',
            repoId: 'repo-1',
            repo: 'repo',
            path: '/tmp/worktree-a',
            branch: 'feature/foo',
            linkedIssue: 123,
            sortOrder: 0,
            unread: true,
            liveTerminalCount: 1,
            hasAttachedPty: true,
            lastOutputAt: 555,
            preview: 'hello'
          }
        ],
        totalCount: 1,
        truncated: false
      }
    })

    await server.stop()
  })
})
