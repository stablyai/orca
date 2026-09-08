import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { MOBILE_WEB_FILE_OPEN_METHOD } from './mobile-web-file-open'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'

function fixture(tabs: unknown[]) {
  const runtime = {
    openMobileFile: vi.fn().mockResolvedValue({ worktree: 'workspace', opened: true }),
    openMobileDiff: vi.fn().mockResolvedValue({ worktree: 'workspace', opened: true }),
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'workspace',
      publicationEpoch: 'e',
      snapshotVersion: 1,
      tabs
    }),
    activateMobileSessionTab: vi
      .fn()
      .mockResolvedValue({ worktree: 'workspace', activeTabId: 'tab-1', tabs })
  }
  return { runtime, context: { runtime } as unknown as RpcContext }
}

describe('mobile web file open', () => {
  it('opens the file and brings its tab to the front', async () => {
    const f = fixture([{ id: 'tab-1', type: 'file', mode: 'edit', relativePath: 'src/index.ts' }])
    expect(
      await MOBILE_WEB_FILE_OPEN_METHOD.handler(
        { worktree: 'id:workspace', relativePath: 'src/index.ts', mode: 'edit', staged: false },
        f.context
      )
    ).toEqual({ opened: true, activated: true })
    expect(f.runtime.openMobileFile).toHaveBeenCalledWith('id:workspace', 'src/index.ts')
    expect(f.runtime.activateMobileSessionTab.mock.calls[0]?.slice(0, 2)).toEqual([
      'id:workspace',
      'tab-1'
    ])
  })

  it('prefers the diff tab matching the staged side the page asked for', async () => {
    const f = fixture([
      { id: 'tab-1', type: 'file', mode: 'diff', relativePath: 'a.ts', diffSource: 'unstaged' },
      { id: 'tab-2', type: 'file', mode: 'diff', relativePath: 'a.ts', diffSource: 'staged' }
    ])
    f.runtime.activateMobileSessionTab.mockResolvedValue({
      worktree: 'workspace',
      activeTabId: 'tab-2',
      tabs: []
    })
    await MOBILE_WEB_FILE_OPEN_METHOD.handler(
      { worktree: 'id:workspace', relativePath: 'a.ts', mode: 'diff', staged: true },
      f.context
    )
    expect(f.runtime.openMobileDiff).toHaveBeenCalledWith('id:workspace', 'a.ts', true)
    expect(f.runtime.activateMobileSessionTab.mock.calls[0]?.[1]).toBe('tab-2')
  })

  it('reports the open when no tab surfaces to activate', async () => {
    const f = fixture([])
    vi.useFakeTimers()
    const opened = MOBILE_WEB_FILE_OPEN_METHOD.handler(
      { worktree: 'id:workspace', relativePath: 'src/index.ts', mode: 'edit', staged: false },
      f.context
    )
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(await opened).toEqual({ opened: true, activated: false })
    expect(f.runtime.activateMobileSessionTab).not.toHaveBeenCalled()
  })

  it('is reachable from a mobile socket', () => {
    expect(isMobileWebHostRpcMethod('mobileWeb.files.open')).toBe(true)
  })
})
