import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import {
  CANARY_TAB_ID,
  LEAF_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  INCARNATION_ID,
  TAB_ID,
  WORKTREE_ID,
  createHarness,
  type CloseContinuityHarness
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

async function closeByPty(harness: CloseContinuityHarness): Promise<unknown> {
  const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
    (candidate) => candidate.ptyId === PTY_ID
  )
  if (!terminal) {
    throw new Error('fixture pane has no terminal handle')
  }
  return harness.runtime.closeTerminal(terminal.handle)
}

/** A PTY-backed tab with no paired-viewer surface: the path orcad serves to the CLI. */
function headlessPtyTab(): CloseContinuityHarness {
  const harness = createHarness({ registerPtyBacked: true, includeCanary: true })
  harness.syncFixtureTabWithoutLeaf()
  harness.setVerifiedStopResult(true)
  return harness
}

function recoveredHandle(harness: CloseContinuityHarness): string {
  const handle = harness.runtime.resolveTerminalHandleByProcessIncarnation(
    `${PTY_ID}:${INCARNATION_ID}`,
    JSON.stringify({ kind: 'local', hostId: 'local' })
  )
  if (!handle) {
    throw new Error('fixture incarnation did not resolve')
  }
  return handle
}

describe('closing a terminal by PTY on a host without a renderer tab', () => {
  it.each(['before writer', 'during flush'] as const)(
    'retires the same saved tab first published %s',
    async (publicationTiming) => {
      const harness = headlessPtyTab()
      harness.syncEmptyGraph()
      const session = harness.getSession()
      const tabs = buildHeadlessMobileSessionTerminalTabs(
        WORKTREE_ID,
        session.tabsByWorktree[WORKTREE_ID]!,
        session
      )
      const publish = () =>
        harness.runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [
            {
              worktree: WORKTREE_ID,
              publicationEpoch: 'renderer:late-close',
              snapshotVersion: 1,
              activeGroupId: null,
              activeTabId: tabs[0]!.id,
              activeTabType: 'terminal',
              tabs
            }
          ]
        })
      if (publicationTiming === 'during flush') {
        harness.flushOrThrow.mockImplementationOnce(publish)
      }
      const close = harness.runtime.closeTerminal(recoveredHandle(harness))
      if (publicationTiming === 'before writer') {
        publish()
      }

      await expect(close).resolves.toMatchObject({ tabId: TAB_ID, ptyKilled: true })

      expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
      expect(harness.stopAndWait).toHaveBeenCalledExactlyOnceWith(PTY_ID, expect.anything())
      const after = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(after.tabs.map((tab) => tab.type === 'terminal' && tab.parentTabId)).toEqual([
        CANARY_TAB_ID
      ])
      expect(after.retiredTerminalSurfaces).toEqual(
        expect.arrayContaining([expect.objectContaining({ parentTabId: TAB_ID, leafId: LEAF_ID })])
      )
    }
  )

  it('retires the saved tab when recovery closes by incarnation before tabs are listed', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    const paneKey = makePaneKey(TAB_ID, LEAF_ID)
    harness.editSession((session) => ({
      ...session,
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'fixture-resume' },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    }))

    await expect(harness.runtime.closeTerminal(recoveredHandle(harness))).resolves.toMatchObject({
      ptyKilled: true
    })

    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      CANARY_TAB_ID
    ])
    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
    expect(harness.getSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toBeUndefined()
    expect(harness.getSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
    expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.stopAndWait.mock.invocationCallOrder[0]!
    )
    expect(harness.stopAndWait).toHaveBeenCalledExactlyOnceWith(PTY_ID, expect.anything())
  })

  it.each(['replacement', 'missing'] as const)(
    'preserves saved membership with a %s incarnation',
    async (incarnation) => {
      const harness = headlessPtyTab()
      harness.syncEmptyGraph()
      if (incarnation === 'replacement') {
        harness.replacePersistedIncarnation('replacement-incarnation')
      } else {
        harness.editSession((session) => ({ ...session, terminalPtyIncarnationsByPaneKey: {} }))
      }
      const before = harness.getSession()

      await harness.runtime.closeTerminal(recoveredHandle(harness))

      expect(harness.getSession()).toEqual(before)
      expect(harness.flushOrThrow).not.toHaveBeenCalled()
      expect(harness.stopAndWait).toHaveBeenCalledExactlyOnceWith(PTY_ID, expect.anything())
    }
  )

  it('refuses a pinned saved tab before stopping its process', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    harness.editSession((session) => ({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          isPinned: true
        }))
      }
    }))

    await expect(harness.runtime.closeTerminal(recoveredHandle(harness))).rejects.toThrow(
      'terminal_tab_pinned'
    )

    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('refuses replacement of the saved tab while its close awaits the writer', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    const close = harness.runtime.closeTerminal(recoveredHandle(harness))
    harness.replacePersistedIncarnation('replacement-incarnation')

    await expect(close).rejects.toThrow('terminal_pane_owner_changed')

    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toBeDefined()
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('does not stop a replacement process registered during the durable flush', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    harness.flushOrThrow.mockImplementationOnce(() => {
      harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'replacement-incarnation'
      })
    })

    await expect(harness.runtime.closeTerminal(recoveredHandle(harness))).rejects.toThrow(
      'terminal_pane_owner_changed'
    )

    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('refuses a newly published sibling while the close awaits the writer', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    const session = harness.getSession()
    const tabs = buildHeadlessMobileSessionTerminalTabs(
      WORKTREE_ID,
      session.tabsByWorktree[WORKTREE_ID]!,
      session
    )
    const close = harness.runtime.closeTerminal(recoveredHandle(harness))
    harness.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE_ID,
          publicationEpoch: 'renderer:new-sibling',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: tabs[0]!.id,
          activeTabType: 'terminal',
          tabs: [
            ...tabs,
            {
              type: 'terminal',
              id: `${TAB_ID}::${SIBLING_LEAF_ID}`,
              parentTabId: TAB_ID,
              leafId: SIBLING_LEAF_ID,
              ptyId: 'new-sibling',
              title: 'New sibling',
              isActive: false
            }
          ]
        }
      ]
    })

    await expect(close).rejects.toThrow('terminal_pane_owner_changed')

    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toBeDefined()
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('does not stop a replacement registered by a close publication subscriber', async () => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    harness.syncEmptyGraph()
    const unsubscribe = harness.runtime.onMobileSessionTabsChanged(() => {
      harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'replacement-incarnation'
      })
    })
    try {
      await expect(harness.runtime.closeTerminal(recoveredHandle(harness))).rejects.toThrow(
        'terminal_pane_owner_changed'
      )
      expect(harness.stopAndWait).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('stops the PTY without asking a missing renderer to close the tab', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })

    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, expect.anything())
  })

  it('does not fail the close when the advisory renderer notification throws', async () => {
    const harness = headlessPtyTab()
    harness.syncEmptyGraph()
    harness.closeTerminal.mockImplementation(() => {
      throw new Error('renderer gone')
    })

    await expect(closeByPty(harness)).resolves.toMatchObject({ tabId: TAB_ID })
  })
})
