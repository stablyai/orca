import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocState } from './mobile-session-route-types'
import {
  useMobileSessionMarkdownActions,
  type MobileSessionMarkdownActionsScope
} from './use-mobile-session-markdown-actions'
import { MarkdownReader } from './MobileSessionMarkdownReader'

const { writeText, success, error, showToast } = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
  success: vi.fn(),
  error: vi.fn(),
  showToast: vi.fn()
}))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Keyboard: { dismiss: vi.fn() }
}))
vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))
vi.mock('../components/MobileRichMarkdownEditor', () => ({
  MobileRichMarkdownEditor: 'MobileRichMarkdownEditor'
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: success, triggerError: error }))
vi.mock('./mobile-session-write-operations', () => ({ markdownTabSave: {} }))

function Probe({ doc }: { doc: MarkdownDocState }) {
  const scope: MobileSessionMarkdownActionsScope = {
    hostId: 'ssh-host',
    worktreeId: 'folder:remote',
    client: null,
    sessionTabs: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copy does not access the router; any unexpected navigation method throws in this probe.
    router: {} as MobileSessionMarkdownActionsScope['router'],
    markdownDocs: new Map([['doc', doc]]),
    setMarkdownDocs: vi.fn(),
    setDiscardMarkdownTarget: vi.fn(),
    discardMarkdownTarget: null,
    setLeaveDrafts: vi.fn(),
    markdownSaveSeqRef: { current: new Map() },
    markdownSaveInFlightRef: { current: new Set() },
    showToast,
    readMarkdownTab: vi.fn()
  }
  const actions = useMobileSessionMarkdownActions(scope)
  return createElement(MarkdownReader, {
    documentId: 'doc',
    doc,
    keyboardLift: 0,
    onChange: vi.fn(),
    onRefresh: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCopy: () => {
      void actions.copyMarkdownLocalContent('doc')
    }
  })
}
const doc: MarkdownDocState = {
  status: 'ready',
  content: '# Saved',
  localContent: '# Unsaved\n\n  local indentation',
  baseVersion: '1',
  isDirty: true,
  editable: true
}

describe('live reader copies through the existing local-content callback', () => {
  let renderer: ReactTestRenderer | undefined
  const press = async () => {
    const copy = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((child) => String(child.type) === 'Text')
          .some((text) => text.props.children === 'Copy')
      )
    if (!copy) {
      throw new Error('Copy is hidden on the live editable document')
    }
    await act(async () => copy.props.onPress())
  }
  beforeEach(() => {
    vi.clearAllMocks()
    writeText.mockResolvedValue(undefined)
    act(() => {
      renderer = create(createElement(Probe, { doc }))
    })
  })
  afterEach(() => act(() => renderer?.unmount()))

  it('copies the unsaved draft, then the newest local edit without a host connection', async () => {
    await press()
    expect(writeText.mock.calls).toEqual([[doc.localContent]])
    const updated = { ...doc, localContent: '# Latest\n\n| A | B |\n| - | - |\n| x | y |' }
    act(() => renderer!.update(createElement(Probe, { doc: updated })))
    await press()
    expect(writeText.mock.calls[1]).toEqual([updated.localContent])
    expect(showToast.mock.calls).toEqual([['Copied'], ['Copied']])
    expect(success).toHaveBeenCalledTimes(2)
  })

  it('shows failure through existing feedback and never shows success on rejection', async () => {
    writeText.mockRejectedValue(new Error('Clipboard denied'))
    await press()
    expect(showToast.mock.calls).toEqual([["Couldn't copy", 1500]])
    expect(error).toHaveBeenCalledOnce()
    expect(success).not.toHaveBeenCalled()
  })
})
