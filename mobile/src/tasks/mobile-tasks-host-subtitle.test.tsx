import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reactNative = vi.hoisted(() => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native', () => reactNative)
vi.mock('./mobile-tasks-dependencies', async () => ({
  ...reactNative,
  ...(await import('../theme/mobile-theme')),
  ChevronLeft: 'Icon',
  Plus: 'Icon',
  RefreshCw: 'Icon',
  StatusDot: 'StatusDot'
}))
vi.mock('./mobile-tasks-legacy-styles', async () => ({
  styles: (await import('./mobile-tasks-chrome-styles')).mobileTasksChromeStyles
}))
vi.mock('./mobile-tasks-provider-controls', () => ({
  renderMobileTasksProviderControls: () => null
}))
vi.mock('./mobile-tasks-search-control', () => ({ renderMobileTasksSearchControl: () => null }))
const hostStore = vi.hoisted(() => {
  const hosts = [
    { id: 'studio', name: 'Studio Mac' },
    { id: 'buildbox', name: 'Build Box' }
  ]
  const pending: (() => void)[] = []
  return {
    /** When set, each read waits for `resolveAll` instead of answering at once. */
    deferred: false,
    pending,
    loadHosts(): Promise<typeof hosts> {
      if (!hostStore.deferred) {
        return Promise.resolve(hosts)
      }
      return new Promise((resolve) => pending.push(() => resolve(hosts)))
    }
  }
})
vi.mock('../transport/host-store', () => ({ loadHosts: () => hostStore.loadHosts() }))

import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { renderMobileTasksStatusBar } from './mobile-tasks-screen-chrome'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'

let renderer: ReactTestRenderer | null = null

function StatusBar({ hostId }: { hostId: string }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status bar reads only the fields set here.
  const model = {
    connState: 'connected',
    hostId,
    router: { back: () => {} },
    taskUiReady: true
  } as unknown as ConnectionPresentationModel
  return createElement(Fragment, null, renderMobileTasksStatusBar(model))
}

async function renderStatusBar(hostId: string): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(createElement(StatusBar, { hostId }))
  })
  return renderer!
}

function subtitleOf(tree: ReactTestRenderer) {
  return tree.root.find(
    (node) => typeof node.type === 'string' && node.props.testID === 'mobile-tasks-host-subtitle'
  )
}

describe('Tasks header desktop subtitle', () => {
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hostStore.deferred = false
    hostStore.pending.length = 0
  })

  it('names the desktop under the Tasks title in the host screen subtitle style', async () => {
    const tree = await renderStatusBar('buildbox')
    const subtitle = subtitleOf(tree)
    expect(subtitle.props.children).toBe('Build Box')
    expect(subtitle.props.style).toContain(hostScreenStyles.hostPlatformText)
    expect(subtitle.props.numberOfLines).toBe(1)
    expect(subtitle.parent!.parent!.findByProps({ children: 'Tasks' })).toBeTruthy()
  })

  it('reserves a blank line for a desktop that is not paired', async () => {
    const tree = await renderStatusBar('gone')
    expect(subtitleOf(tree).props.children).toBe('')
  })

  it('reserves the line before the read and never shows the previous desktop after a switch', async () => {
    hostStore.deferred = true
    const tree = await renderStatusBar('studio')
    // Reserved and blank while the first read is in flight, so the title does not move later.
    expect(subtitleOf(tree).props.children).toBe('')
    await act(async () => {
      tree.update(createElement(StatusBar, { hostId: 'buildbox' }))
    })
    expect(subtitleOf(tree).props.children).toBe('')
    // Studio Mac's read answers after the switch; only Build Box's may land.
    await act(async () => {
      hostStore.pending.shift()!()
    })
    expect(subtitleOf(tree).props.children).toBe('')
    await act(async () => {
      hostStore.pending.shift()!()
    })
    expect(subtitleOf(tree).props.children).toBe('Build Box')
  })
})
