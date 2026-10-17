import { createElement, useLayoutEffect, useState, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMobileSourceControlActions } from './mobile-source-control-actions'
import { MobileSourceControlModals } from './MobileSourceControlModals'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

// iOS cannot present a native Modal while another is still presented, even mid-close: the incoming
// one is dropped and the screen is left dead to taps. Each mounted MountedBottomDrawer is one native
// Modal, so this mock records how many are mounted at once. Tapping "Switch branch" in the source
// control action sheet must never put the picker's Modal up beside the closing action sheet's.
// stablyai/orca#25294; the iOS race is react/react-native#50152.

type Drawer = { visible: boolean; onHidden: () => void; text: string }
const modals = vi.hoisted(() => ({ live: new Set<Drawer>(), maxLive: 0 }))

vi.mock('../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: function MockMountedBottomDrawer(props: {
    visible: boolean
    onHidden: () => void
    children: ReactElement
  }) {
    const [drawer] = useState((): Drawer => ({ visible: true, onHidden: () => {}, text: '' }))
    useLayoutEffect(() => {
      drawer.visible = props.visible
      drawer.onHidden = props.onHidden
    })
    useLayoutEffect(() => {
      modals.live.add(drawer)
      modals.maxLive = Math.max(modals.maxLive, modals.live.size)
      return () => {
        modals.live.delete(drawer)
      }
    }, [])
    return createElement('Drawer', null, props.children)
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', Edit3: 'Edit3', Trash2: 'Trash2' }))
vi.mock('./MobileBranchDiffPreviewDrawer', () => ({ MobileBranchDiffPreviewDrawer: () => null }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))

const BRANCHES = { current: 'main', branches: ['main', 'feature-a', 'feature-b'] }

function Harness() {
  const [showActionSheet, setShowActionSheet] = useState(true)
  const [showBranchPicker, setShowBranchPicker] = useState(false)
  const [localBranches, setLocalBranches] = useState<typeof BRANCHES | null>(null)

  // Same steps as openBranchPicker in use-mobile-source-control-runners.ts; the branch list
  // arrives on a later tick, as it does over the RPC.
  const openBranchPicker = () => {
    setShowActionSheet(false)
    setLocalBranches(null)
    setShowBranchPicker(true)
    void Promise.resolve().then(() => setLocalBranches(BRANCHES))
  }

  const noop = () => {}
  const actions = buildMobileSourceControlActions({
    commitMessage: '',
    stagedCount: 0,
    upstream: null,
    upstreamKnown: false,
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    prAvailable: false,
    handlers: {
      commit: noop,
      commitPush: noop,
      commitSync: noop,
      push: noop,
      pull: noop,
      sync: noop,
      fetch: noop,
      publish: noop,
      fastForward: noop,
      rebase: noop,
      createPr: noop,
      pushAndCreatePr: noop,
      checkout: openBranchPicker,
      history: noop
    }
  })

  const state = {
    branchDiffPreview: null,
    setBranchDiffPreview: noop,
    showActionSheet,
    setShowActionSheet,
    discardTarget: null,
    setDiscardTarget: noop,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl: null,
    setCreatedPrUrl: noop,
    createdPrWarning: null,
    setCreatedPrWarning: noop,
    branchLabel: 'main',
    checkoutBranch: async () => {},
    runGitAction: async () => {}
  } as unknown as MobileSourceControlState

  return createElement(MobileSourceControlModals, { state, actionSheetActions: actions })
}

function textOf(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.children.join(''))
}

// Plays every closing drawer's hide animation to its end, as Reanimated would.
async function finishHideAnimations() {
  for (const drawer of [...modals.live].filter((d) => !d.visible)) {
    await act(async () => drawer.onHidden())
  }
}

describe('Switch branch from the source control action sheet', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    modals.live.clear()
    modals.maxLive = 0
  })

  it('opens the branch picker only after the action sheet Modal has gone, then lists the branches', async () => {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(modals.live.size).toBe(1)

    const switchBranch = renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.findAll((n) => String(n.type) === 'Text' && n.children.join('') === 'Switch branch')
          .length > 0
    )
    await act(async () => switchBranch.props.onPress())
    await finishHideAnimations()
    await finishHideAnimations()

    // The iOS rule: never two native Modals up at once.
    expect(modals.maxLive).toBe(1)
    const text = textOf(renderer!)
    expect(text).toContain('Switch Branch')
    expect(text).toEqual(expect.arrayContaining(['main', 'feature-a', 'feature-b']))
  })
})
