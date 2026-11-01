import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { ActionSheetAction } from './ActionSheetModal'

vi.mock('lucide-react-native', () => ({
  Check: 'Icon',
  Copy: 'Icon',
  FileText: 'Icon',
  Send: 'Icon',
  Trash2: 'Icon',
  X: 'Icon'
}))

import { useMobileDiffReviewOverflowActions } from './use-mobile-diff-review-overflow-actions'

type Controller = Parameters<typeof useMobileDiffReviewOverflowActions>[0]

async function reviewActions(executionHost?: string): Promise<ActionSheetAction[]> {
  let actions: ActionSheetAction[] = []
  const controller = mountFixture<Controller>({
    reviewedUnstagedCount: 0,
    screenState: { kind: 'loading' },
    currentItem: null,
    busyAction: null,
    unsentComments: []
  })
  function Probe() {
    actions = useMobileDiffReviewOverflowActions(controller)
    return null
  }
  await act(async () => {
    create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: normalizeExecutionHostId(executionHost) ?? undefined },
        createElement(Probe)
      )
    )
  })
  return actions
}

const labels = (actions: ActionSheetAction[]) => actions.map((action) => action.label)

describe('the review screen’s ⋯ menu', () => {
  it('offers Open in Session for a workspace the desktop hosts', async () => {
    expect(labels(await reviewActions())).toContain('Open in Session')
  })

  it('leaves out Open in Session for a server workspace, whose host has no editor tabs', async () => {
    const actions = labels(await reviewActions('runtime:vm'))
    expect(actions).not.toContain('Open in Session')
    expect(actions).toContain('Copy Notes')
  })

  // iOS can't present the Send Notes sheet over the menu's modal, so it must wait for the menu to close.
  it('opens Send Notes only once the menu has closed', async () => {
    const send = (await reviewActions()).find((action) => action.id === 'sendUnsentNotes')
    expect(send?.closeBeforePress).toBe(true)
  })
})
