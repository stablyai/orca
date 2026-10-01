import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { PRConflictingFilesSection } from './PRConflictingFilesSection'
import { buildMergeabilityRefreshCommands } from './pr-conflict-presentation'

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Copy: 'Copy',
  FileWarning: 'FileWarning',
  Sparkles: 'Sparkles'
}))

vi.mock('../../platform/clipboard', () => ({ useClipboardWriter: () => clipboard }))

vi.mock('./PRSection', () => ({
  PRSection: ({ children }: { children: unknown }) => children
}))

/**
 * A PR the resolver gives the refresh commands to, which is the only path that copies: the host
 * reports CONFLICTING, has no file list to show, and the local merge came back clean — the
 * disagreement the commands exist to resolve.
 */
const PR: Pick<PRInfo, 'mergeable' | 'conflictSummary'> = {
  mergeable: 'CONFLICTING',
  conflictSummary: {
    files: [],
    localMergeState: 'clean',
    commitsBehind: 2,
    baseCommit: 'abc1234',
    baseRef: 'main'
  }
}

const COMMANDS = buildMergeabilityRefreshCommands()

function press(tree: ReactTestRenderer): Promise<void> {
  const control = tree.root
    .findAll((node) => node.props.accessibilityLabel === 'Copy mergeability refresh commands')
    .at(0)
  if (!control) {
    throw new Error('the copy control is not rendered')
  }
  return act(async () => control.props.onPress())
}

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.children === 'string')
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
}

describe('copying the mergeability refresh commands', () => {
  let tree: ReactTestRenderer | null = null

  beforeEach(() => {
    clipboard.writeText.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  async function render(): Promise<ReactTestRenderer> {
    let rendered: ReactTestRenderer | null = null
    await act(async () => {
      rendered = create(createElement(PRConflictingFilesSection, { pr: PR }))
    })
    if (rendered === null) {
      throw new Error('the section did not render')
    }
    tree = rendered
    return rendered
  }

  it('says it copied when the pasteboard took the commands', async () => {
    const rendered = await render()
    await press(rendered)
    expect(clipboard.writeText).toHaveBeenCalledWith(COMMANDS)
    expect(labels(rendered)).toContain('Copied')
  })

  it('says it failed instead of saying nothing at all', async () => {
    // The seam rejects when the pasteboard refused, which inside the page is a route that was not
    // granted the verb. Dropped, the tap is indistinguishable from one that copied nothing.
    clipboard.writeText.mockRejectedValue(new Error('the clipboard did not accept this text'))
    const rendered = await render()
    await press(rendered)
    expect(labels(rendered)).toContain('Failed to copy text')
    expect(labels(rendered)).not.toContain('Copied')
  })
})
