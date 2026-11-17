import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import {
  CANARY_TAB_ID,
  LEAF_ID,
  PTY_ID,
  INCARNATION_ID,
  TAB_ID,
  WORKTREE_ID
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import {
  createHarness,
  type CloseContinuityHarness
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

/** CLI/headless path: PTY-backed tab without a paired-viewer surface. */
async function headlessPtyTab(): Promise<CloseContinuityHarness> {
  const harness = await createHarness({ registerPtyBacked: true, includeCanary: true })
  await harness.syncFixtureTabWithoutLeaf()
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

describe('closing a saved terminal tab on a host without a renderer tab', () => {
  it.each(['before writer', 'during flush'] as const)(
    'retires the same saved tab first published %s',
    async (publicationTiming) => {
      const harness = await headlessPtyTab()
      await harness.syncEmptyGraph()
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
    const harness = await headlessPtyTab()
    await harness.syncEmptyGraph()
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
      const harness = await headlessPtyTab()
      await harness.syncEmptyGraph()
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
    const harness = await headlessPtyTab()
    await harness.syncEmptyGraph()
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
    const harness = await headlessPtyTab()
    await harness.syncEmptyGraph()
    const close = harness.runtime.closeTerminal(recoveredHandle(harness))
    harness.replacePersistedIncarnation('replacement-incarnation')
    const replaced = harness.getSession()

    // The durable close re-resolves its PTY authority at commit, as it does for a published tab.
    await expect(close).rejects.toThrow('terminal_handle_stale')

    expect(harness.getSession()).toEqual(replaced)
    expect(harness.flushOrThrow).not.toHaveBeenCalled()
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('keeps the saved tab and its process when the session is unavailable at commit', async () => {
    const harness = await headlessPtyTab()
    await harness.syncEmptyGraph()
    const close = harness.runtime.closeTerminal(recoveredHandle(harness))
    harness.makeSessionUnavailable()

    await expect(close).rejects.toThrow('workspace_session_unavailable')

    expect(harness.getSession().terminalLayoutsByTabId[TAB_ID]).toBeDefined()
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('still stops a published surface when the session is unavailable at commit', async () => {
    const harness = await createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    harness.setVerifiedStopResult(true)
    await harness.syncEmptyGraph()
    const close = harness.runtime.closeTerminal(recoveredHandle(harness))
    harness.makeSessionUnavailable()

    await expect(close).resolves.toMatchObject({ tabId: TAB_ID, ptyKilled: true })
    expect(harness.stopAndWait).toHaveBeenCalledExactlyOnceWith(PTY_ID, expect.anything())
  })

  it('does not stop a replacement process registered during the durable flush', async () => {
    const harness = await headlessPtyTab()
    await harness.syncEmptyGraph()
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
})
