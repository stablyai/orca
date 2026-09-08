import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_TERMINAL_ARTIFACT_METHODS } from './mobile-web-terminal-artifact'

const [resolvePath, artifactChunk] = MOBILE_WEB_TERMINAL_ARTIFACT_METHODS
const TAB = {
  id: 'tab-1',
  type: 'terminal',
  status: 'ready',
  terminal: 'private-terminal',
  isActive: true
}

function fixture(overrides: { openTarget?: unknown; worktree?: string } = {}) {
  const runtime = {
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'workspace-1',
      activeTabId: 'tab-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [TAB]
    }),
    resolveTerminalPath: vi.fn().mockResolvedValue({
      worktree: overrides.worktree ?? 'workspace-1',
      relativePath: null,
      absolutePath: '/private/results/report.png',
      exists: true,
      isDirectory: false,
      openTarget: overrides.openTarget ?? {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: '/private/results/report.png',
        grantId: 'desktop-grant'
      }
    }),
    readTerminalArtifactChunk: vi
      .fn()
      .mockResolvedValue({ contentBase64: 'T0s=', bytesRead: 2, eof: true })
  }
  const context = { runtime, clientId: 'device', pairedDeviceId: 'device' } as unknown as RpcContext
  return { runtime, context }
}

const target = {
  worktree: 'id:workspace-1',
  tabId: 'tab-1',
  pathText: '/private/results/report.png'
}
const resolveParams = { ...target, line: 3, column: null }

describe('mobile web terminal artifacts', () => {
  it('describes the artifact without handing the page a host path or grant', async () => {
    const f = fixture()
    const result = await resolvePath.handler(resolveParams, f.context)
    expect(result).toEqual({
      kind: 'terminal-artifact',
      displayName: 'report.png',
      previewKind: 'raster',
      line: 3,
      column: null
    })
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(JSON.stringify(result)).not.toContain('desktop-grant')
  })

  it('answers a worktree-relative hit with its relative path', async () => {
    const f = fixture({
      openTarget: {
        kind: 'worktree-file',
        provider: 'local',
        relativePath: 'docs/report.md',
        absolutePath: '/private/repo/docs/report.md'
      }
    })
    expect(await resolvePath.handler(resolveParams, f.context)).toEqual({
      kind: 'worktree-file',
      relativePath: 'docs/report.md',
      displayName: 'report.md',
      previewKind: 'text',
      line: 3,
      column: null
    })
  })

  it('refuses a resolution that lands in another worktree', async () => {
    const f = fixture({ worktree: 'workspace-2' })
    await expect(resolvePath.handler(resolveParams, f.context)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('re-earns the grant on every chunk instead of holding one', async () => {
    const f = fixture()
    expect(await artifactChunk.handler({ ...target, offset: 0, length: 2 }, f.context)).toEqual({
      pathText: '/private/results/report.png',
      offset: 0,
      contentBase64: 'T0s=',
      bytesRead: 2,
      eof: true
    })
    await artifactChunk.handler({ ...target, offset: 2, length: 2 }, f.context)
    expect(f.runtime.resolveTerminalPath).toHaveBeenCalledTimes(2)
    expect(f.runtime.readTerminalArtifactChunk.mock.calls[0]?.slice(0, 3)).toEqual([
      'id:workspace-1',
      'desktop-grant',
      '/private/results/report.png'
    ])
  })

  it('reads through the terminal the tab list names, not one the page asserts', async () => {
    const f = fixture()
    await artifactChunk.handler({ ...target, offset: 0, length: 2 }, f.context)
    expect(f.runtime.resolveTerminalPath.mock.calls[0]?.[4]).toBe('private-terminal')
  })

  it('stops serving bytes once the tab no longer runs a ready terminal', async () => {
    const f = fixture()
    f.runtime.listMobileSessionTabs.mockResolvedValue({
      worktree: 'workspace-1',
      activeTabId: 'tab-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 2,
      tabs: [{ ...TAB, status: 'exited' }]
    })
    await expect(
      artifactChunk.handler({ ...target, offset: 0, length: 2 }, f.context)
    ).rejects.toThrow('selector_not_found')
    expect(f.runtime.readTerminalArtifactChunk).not.toHaveBeenCalled()
  })

  it('refuses a chunk read for a path that resolves inside the worktree', async () => {
    const f = fixture({
      openTarget: {
        kind: 'worktree-file',
        provider: 'local',
        relativePath: 'docs/report.md',
        absolutePath: '/private/repo/docs/report.md'
      }
    })
    await expect(
      artifactChunk.handler({ ...target, offset: 0, length: 2 }, f.context)
    ).rejects.toThrow('selector_not_found')
  })

  it('is reachable from a mobile socket', () => {
    for (const method of MOBILE_WEB_TERMINAL_ARTIFACT_METHODS) {
      expect(isMobileWebHostRpcMethod(method.name), method.name).toBe(true)
    }
  })
})
