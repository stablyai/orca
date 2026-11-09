import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDownloadProgressFeed } from '../mobile-web-shell/download-progress-feed'
import type { ShellOverlayDownload, ShellOverlayLoad } from '../mobile-web-shell/shell-overlay-load'

type LoadingDrawerProps = {
  visible: boolean
  download: ShellOverlayDownload | null
  onCancel: () => void
}

const router = vi.hoisted(() => ({ back: vi.fn() }))
const shell = vi.hoisted((): { report: ((load: ShellOverlayLoad) => void) | null } => ({
  report: null
}))
const layerMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('expo-router', () => ({ useRouter: () => router }))
vi.mock('../components/HostProtocolGate', () => ({
  HostProtocolGate: ({ children }: { children: ReactNode }) => children
}))
vi.mock('./open-host-list-instead', () => ({ OpenHostListInstead: 'OpenHostListInstead' }))
vi.mock('../mobile-web-shell/MobileWebShellScreen', () => ({
  MobileWebShellScreen: ({
    onOverlayLoad
  }: {
    onOverlayLoad: (load: ShellOverlayLoad) => void
  }) => {
    shell.report = onOverlayLoad
    return null
  }
}))
vi.mock('./NewWorkspaceLoadingDrawer', async () => {
  const { createElement: element } = await import('react')
  return {
    NewWorkspaceLoadingDrawer: (props: LoadingDrawerProps) => {
      useEffect(() => {
        layerMounts.count += 1
      }, [])
      return element('NewWorkspaceLoadingDrawer', props)
    }
  }
})

import { NewWorkspaceOverlay } from './NewWorkspaceOverlay'

describe("the New Workspace overlay's loading drawer", () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    shell.report = null
    layerMounts.count = 0
    vi.clearAllMocks()
  })

  function layer() {
    return renderer!.root.findAll((node) => String(node.type) === 'NewWorkspaceLoadingDrawer')[0]
  }

  it('stays one mounted drawer from the first wait through the download until the page paints', () => {
    act(() => {
      renderer = create(createElement(NewWorkspaceOverlay, { hostId: 'desk' }))
    })
    expect(layer().props).toMatchObject({ visible: true, download: null })

    const download = { receivedBytes: 1, totalBytes: 8, feed: createDownloadProgressFeed() }
    act(() => shell.report!({ kind: 'loading', download }))
    expect(layer().props.download).toBe(download)
    act(() => shell.report!({ kind: 'loading', download: null }))
    expect(layer().props.download).toBeNull()
    expect(layerMounts.count).toBe(1)

    act(() => shell.report!({ kind: 'painted' }))
    expect(layer().props.visible).toBe(false)
    expect(layerMounts.count).toBe(1)
  })

  it('leaves when the load is cancelled', () => {
    act(() => {
      renderer = create(createElement(NewWorkspaceOverlay, { hostId: 'desk' }))
    })

    act(() => layer().props.onCancel())

    expect(router.back).toHaveBeenCalledTimes(1)
  })

  it('opens the host list instead when the page cannot show here', () => {
    act(() => {
      renderer = create(createElement(NewWorkspaceOverlay, { hostId: 'desk' }))
    })

    act(() => shell.report!({ kind: 'unavailable' }))

    expect(
      renderer!.root.find((node) => String(node.type) === 'OpenHostListInstead').props.hostId
    ).toBe('desk')
  })
})
