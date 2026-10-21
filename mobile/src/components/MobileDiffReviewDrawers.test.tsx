import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from './ActionSheetModal'

const sheet = vi.hoisted(() => {
  const state: { labels: string[] } = { labels: [] }
  return state
})

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Icon',
  Copy: 'Icon',
  FileText: 'Icon',
  Plus: 'Icon',
  Send: 'Icon',
  Trash2: 'Icon',
  X: 'Icon'
}))
vi.mock('./ActionSheetModal', () => ({
  ActionSheetContent: ({ actions }: { actions: ActionSheetAction[] }) => {
    sheet.labels = actions.map((action) => action.label)
    return null
  }
}))
vi.mock('./ConfirmModal', () => ({ ConfirmContent: () => null }))
vi.mock('./keyed-bottom-drawer', () => ({
  KeyedBottomDrawer: ({
    sheet: presented,
    children
  }: {
    sheet: unknown
    children: (presented: unknown) => unknown
  }) => children(presented)
}))

import { MobileDiffReviewDrawers } from './MobileDiffReviewDrawers'

async function reviewActionLabels(executionHost?: string): Promise<string[]> {
  sheet.labels = []
  const controller = mountFixture<Parameters<typeof MobileDiffReviewDrawers>[0]['controller']>({
    sheet: { kind: 'actions' },
    reviewedUnstagedCount: 0,
    screenState: { kind: 'loading' },
    currentItem: null,
    busyAction: null,
    unsentComments: []
  })
  await act(async () => {
    create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: normalizeExecutionHostId(executionHost) ?? undefined },
        createElement(MobileDiffReviewDrawers, { controller })
      )
    )
  })
  return sheet.labels
}

describe('the review screen’s actions', () => {
  it('offers Open in Session for a workspace the desktop hosts', async () => {
    expect(await reviewActionLabels()).toContain('Open in Session')
  })

  it('leaves out Open in Session for a server workspace, whose host has no editor tabs', async () => {
    const labels = await reviewActionLabels('runtime:vm')
    expect(labels).not.toContain('Open in Session')
    expect(labels).toContain('Copy Notes')
  })
})
