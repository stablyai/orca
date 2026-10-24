import { describe, expect, it } from 'vitest'
import { terminalTreeHasLeaf } from '../../shared/terminal-tab-close'
import {
  createHarness,
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  TAB_ID,
  WORKTREE_ID
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

function captured(harness: ReturnType<typeof createHarness>) {
  const source = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
  if (!source.presentation || !source.incarnationId) {
    throw new Error('Missing original source')
  }
  const { incarnationId, presentation } = source
  return {
    source,
    close: () => harness.runtime.closeTerminal(source.handle, incarnationId, presentation)
  }
}

function addSibling(harness: ReturnType<typeof createHarness>) {
  harness.editSession((state) => ({
    ...state,
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      [TAB_ID]: {
        ...state.terminalLayoutsByTabId[TAB_ID],
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.7,
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
        },
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SIBLING_LEAF_ID]: SIBLING_PTY_ID },
        activeLeafId: SIBLING_LEAF_ID,
        expandedLeafId: SIBLING_LEAF_ID
      }
    }
  }))
}

describe('original-aware terminal close owner transaction', () => {
  it('stops only the source and keeps membership until explicit owner retirement', async () => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    const { close } = captured(harness)
    harness.setStopAndWaitAction(async () => {
      await harness.runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
      expect(
        terminalTreeHasLeaf(harness.getSession().terminalLayoutsByTabId[TAB_ID]?.root, LEAF_ID)
      ).toBe(true)
    })
    harness.setVerifiedStopResult(true)
    harness.setCloseTerminalTabAction(() => {})
    await expect(close()).resolves.toMatchObject({ ptyKilled: true })
    expect(harness.stopAndWait).toHaveBeenCalledExactlyOnceWith(
      PTY_ID,
      expect.objectContaining({ expectedIncarnationId: INCARNATION_ID })
    )
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(harness.getSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
  })

  it.each([false, true])(
    'accepts earned exit without another stop (readable=%s)',
    async (readable) => {
      const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
      const { close, source } = captured(harness)
      const settleSleep = readable
        ? harness.runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', INCARNATION_ID)
        : null
      await harness.runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
      settleSleep?.(true)
      expect(harness.runtime.getTerminalHandleForPaneKey(`${TAB_ID}:${LEAF_ID}`)).toBe(
        source.handle
      )
      if (readable) {
        harness.runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              title: 'Ended source',
              activeLeafId: LEAF_ID,
              layout: { type: 'leaf', leafId: LEAF_ID }
            }
          ],
          leaves: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              leafId: LEAF_ID,
              paneRuntimeId: 7,
              ptyId: null
            }
          ]
        })
        expect(harness.runtime.getTerminalHandleForPaneKey(`${TAB_ID}:${LEAF_ID}`)).toBe(
          source.handle
        )
        harness.editSession((state) => ({
          ...state,
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            [TAB_ID]: { ...state.terminalLayoutsByTabId[TAB_ID], ptyIdsByLeafId: {} }
          }
        }))
      }
      harness.runtime.dropArchivedPtyRecord(PTY_ID)
      if (readable) {
        expect(
          harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID).handle
        ).toBe(source.handle)
      }
      harness.setCloseTerminalTabAction(() => {})
      await expect(close()).resolves.toMatchObject({ ptyKilled: true })
      expect(harness.stopAndWait).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
    }
  )

  it('does not retire a successor published during the required durable write', async () => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    const { close } = captured(harness)
    harness.setVerifiedStopResult(true)
    harness.setCloseTerminalTabAction(() => {})
    harness.flushOrThrow.mockImplementationOnce(() => {
      harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'successor-after-admission'
      })
    })
    await expect(close()).rejects.toThrow('terminal_pane_owner_changed')
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.stopAndWait).toHaveBeenCalledTimes(1)
  })

  it('retains an unknown source and refuses a pinned final tab before stopping', async () => {
    const harness = createHarness({ registerPtyBacked: true })
    const { close } = captured(harness)
    await expect(close()).rejects.toThrow('terminal_close_unverifiable')
    expect(harness.closeTerminalTab).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    harness.editSession((state) => ({
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((row) => ({ ...row, isPinned: true }))
      }
    }))
    await expect(close()).rejects.toThrow('terminal_tab_pinned')
    expect(harness.stopAndWait).toHaveBeenCalledTimes(1)
  })

  it.each(['sibling', 'successor', 'write failure'] as const)(
    'revalidates %s after the acknowledged owner await',
    async (change) => {
      const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
      const { close } = captured(harness)
      harness.setVerifiedStopResult(true)
      harness.setCloseTerminalTabAction(() => {
        addSibling(harness)
        if (change === 'successor') {
          harness.replacePersistedIncarnation('incarnation-successor')
        }
        if (change === 'write failure') {
          harness.rejectPersistenceFlush(new Error('required write failed'))
        }
      })
      const result = close()
      if (change === 'successor') {
        await expect(result).rejects.toThrow('terminal_pane_owner_changed')
      } else if (change === 'write failure') {
        await expect(result).rejects.toThrow('required write failed')
      } else {
        await expect(result).resolves.toMatchObject({ ptyKilled: true })
      }
      const layout = harness.getSession().terminalLayoutsByTabId[TAB_ID]
      expect(terminalTreeHasLeaf(layout?.root, SIBLING_LEAF_ID)).toBe(true)
      expect(layout?.ptyIdsByLeafId?.[SIBLING_LEAF_ID]).toBe(SIBLING_PTY_ID)
      expect(terminalTreeHasLeaf(layout?.root, LEAF_ID)).toBe(change === 'successor')
      expect(harness.kill).not.toHaveBeenCalled()
      expect(harness.stopAndWait).toHaveBeenCalledTimes(1)
    }
  )
})
