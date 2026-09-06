import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import type { MobileFilePreviewRouteState } from './mobile-file-preview-route'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import { sourceKeyForPreview } from './mobile-file-preview-source'
import {
  hasUnsavedMobileTerminalArtifactDraft,
  isEditableMobileTerminalArtifactPreview,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './mobile-file-preview-editability'

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView'
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() })
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  Save: 'Save'
}))

vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => vi.fn(),
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))

vi.mock('../theme/mobile-theme', () => ({
  colors: { textPrimary: '#fff', textSecondary: '#999' },
  spacing: { md: 16 }
}))

vi.mock('./mobile-file-preview-styles', () => ({
  filePreviewStyles: {}
}))

vi.mock('./MobileFilePreviewBody', () => ({
  MobileFilePreviewBody: 'MobileFilePreviewBody'
}))

vi.mock('./default-host-file-preview-operations', () => ({
  defaultHostFilePreviewOperations: vi.fn()
}))

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

describe('MobileFilePreviewScreen', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.restoreAllMocks()
  })

  it('treats empty terminal artifact text previews as editable', () => {
    expect(isEditableMobileTerminalArtifactPreview({ status: 'empty', kind: 'text' })).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: '',
        truncated: false,
        byteLength: 0
      })
    ).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'image',
        dataUri: 'data:image/png;base64,aW1n'
      })
    ).toBe(false)
  })

  it('treats truncated terminal artifact text previews as read-only', () => {
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: 'partial',
        truncated: true,
        byteLength: 1024
      })
    ).toBe(false)
  })

  it('treats native-chat artifact grants as read-only', () => {
    expect(
      isEditableMobileTerminalArtifactPreview(
        {
          status: 'ready',
          kind: 'text',
          content: '<h1>Result</h1>',
          truncated: false,
          byteLength: 15
        },
        true
      )
    ).toBe(false)
  })

  it('keeps dirty terminal artifact drafts protected while preview is waiting for reconnect', () => {
    const sourceKey = sourceKeyForPreview({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })

    expect(
      hasUnsavedMobileTerminalArtifactDraft({
        source: 'terminalArtifact',
        draftSourceKey: sourceKey,
        previewSourceKey: sourceKey,
        draftContent: '{"ok":false}',
        savedContent: '{"ok":true}'
      })
    ).toBe(true)
  })

  it('keeps dirty terminal artifact drafts when a reload fails or waits', () => {
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'error',
        message: 'Unable to reach desktop filesystem',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'waiting',
        message: 'Waiting for desktop...',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(false, {
        status: 'error',
        message: 'Unable to load preview',
        reconnect: false
      })
    ).toBe(false)
  })

  it('does not reload when an equivalent route object is rendered', async () => {
    const route: MobileFilePreviewRouteState = {
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'worktree-1',
        relativePath: 'Casks/orca.rb',
        source: 'worktree'
      }
    }
    const operations: HostFilePreviewOperations = {
      load: vi.fn(async () => ({
        status: 'ready',
        kind: 'text',
        content: 'cask "orca" do',
        truncated: false,
        byteLength: 14
      })),
      saveTerminalArtifact: vi.fn(),
      reconnect: vi.fn(),
      openExternalUrl: vi.fn()
    }
    const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileFilePreviewScreen, {
            route,
            operations,
            connectionState: 'connected',
            nativeHostBinding: false
          })
        )
      })
      await act(async () => {
        renderer!.update(
          createElement(MobileFilePreviewScreen, {
            route: { ok: true, params: { ...route.params } },
            operations,
            connectionState: 'connected',
            nativeHostBinding: false
          })
        )
      })
    } finally {
      restoreConsoleError()
    }

    expect(operations.load).toHaveBeenCalledTimes(1)
  })
})
