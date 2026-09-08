import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { openMobileFileTap } from '../session/mobile-file-tap-open'
import { normalizeMobileFilePreviewRouteParams } from './mobile-file-preview-route'
import { previewSourceFromRoute } from './mobile-file-preview-source'
import { webHostFilePreviewOperations } from './web-host-file-preview-operations'

describe('hosted terminal artifact preview', () => {
  it.each(['Remote connection dropped', 'ENOENT'])(
    'shows a load error when artifact reading fails: %s',
    async (message) => {
      const fileReadTerminalArtifactChunk = vi.fn().mockRejectedValue(new Error(message))
      const operations = webHostFilePreviewOperations({
        fileReadTerminalArtifactChunk
      } as unknown as MobileWebBridgeClient)
      await expect(
        operations.load({
          source: 'webArtifact',
          worktreeId: 'folder-1',
          tabId: 'terminal-1',
          pathText: '/tmp/result.txt',
          displayName: 'result.txt',
          previewKind: 'text'
        })
      ).resolves.toEqual({
        status: 'error',
        message: message === 'ENOENT' ? 'File not found' : 'Unable to reach the desktop filesystem',
        reconnect: message !== 'ENOENT'
      })
    }
  )

  it.each(['text', 'raster'] as const)(
    'opens a %s artifact through the existing preview route',
    async (previewKind) => {
      const pathText = previewKind === 'text' ? '/tmp/result.html' : 'C:\\Temp\\result.png'
      const bytes =
        previewKind === 'text'
          ? new TextEncoder().encode('a😀z')
          : Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
      const fileReadTerminalArtifactChunk = vi.fn(async (request) => {
        const chunk = bytes.slice(request.offset, request.offset + 3)
        return {
          ...request,
          bytes: chunk,
          bytesRead: chunk.length,
          eof: request.offset + chunk.length === bytes.length
        }
      })
      const operations = webHostFilePreviewOperations({
        fileReadTerminalArtifactChunk
      } as unknown as MobileWebBridgeClient)
      const pushPreviewRoute = vi.fn()
      openMobileFileTap({
        operations: {
          resolveTerminalPath: vi.fn().mockResolvedValue({
            kind: 'web-artifact',
            pathText,
            displayName: previewKind === 'text' ? 'result.html' : 'result.png',
            previewKind,
            workspaceId: 'folder-1'
          }),
          openWorktreeFile: vi.fn()
        },
        hostId: 'host-1',
        worktreeId: 'folder-1',
        terminalHandle: 'terminal-1',
        pathText,
        line: 2,
        column: 3,
        pushPreviewRoute,
        openBrowser: vi.fn(),
        triggerOpenFeedback: vi.fn(),
        fetchSessionTabs: vi.fn(),
        getSessionTabs: () => [],
        getActiveSessionTabId: () => null,
        getActivationState: (activated) => ({
          activated,
          activationSeq: 1,
          latestActivationSeq: 1,
          sourceTerminalHandle: 'terminal-1',
          activeTerminalHandle: 'terminal-1',
          activeTabType: 'terminal'
        }),
        switchSessionTab: vi.fn(),
        scheduleDelayedAction: vi.fn()
      })
      await Promise.resolve()
      expect(pushPreviewRoute).toHaveBeenCalledOnce()
      const href = pushPreviewRoute.mock.calls[0][0]
      expect(href.pathname).toBe('/h/[hostId]/files/preview/[worktreeId]')
      expect(href.params).toMatchObject({
        name: previewKind === 'text' ? 'result.html' : 'result.png',
        line: '2',
        column: '3'
      })
      const route = normalizeMobileFilePreviewRouteParams(href.params)
      expect(route.ok).toBe(true)
      if (!route.ok) {
        throw new Error(route.message)
      }
      const source = previewSourceFromRoute(route.params)
      expect(source).not.toBeNull()
      const result = await operations.load(source!)
      expect(result).toEqual(
        previewKind === 'text'
          ? {
              status: 'ready',
              kind: 'text',
              content: 'a😀z',
              truncated: false,
              byteLength: bytes.length
            }
          : { status: 'ready', kind: 'image', dataUri: 'data:image/png;base64,iVBORw0KGgo=' }
      )
      expect(fileReadTerminalArtifactChunk).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          workspaceId: 'folder-1',
          tabId: 'terminal-1',
          pathText,
          offset: 3
        })
      )
    }
  )
})
