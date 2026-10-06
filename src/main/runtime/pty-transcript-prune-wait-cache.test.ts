// A disconnected transcript must not keep a wait-scan cache from before its history was pruned.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { MAX_TAIL_LINES } from './terminal-tail-limits'
import * as terminalWaitTailState from './terminal-wait-tail-state'
import type { TerminalTailWaitState } from './terminal-wait-tail-state'

type PtyRecord = {
  connected: boolean
  tailBuffer: string[]
  tailWaitState?: TerminalTailWaitState
}
type RuntimeInternals = {
  recordPtyWorktree: (p: string, w: string, s?: { connected?: boolean }) => PtyRecord
  pruneDisconnectedPtyTranscript: (pty: PtyRecord) => void
}

function onlyRuntimeLeaf(runtime: unknown) {
  if (typeof runtime !== 'object' || runtime === null || !('leaves' in runtime)) {
    throw new Error('Runtime has no leaves')
  }
  const leaves = runtime.leaves
  if (!(leaves instanceof Map) || leaves.size !== 1) {
    throw new Error('Expected exactly one runtime leaf')
  }
  const leaf: unknown = leaves.values().next().value
  if (
    typeof leaf !== 'object' ||
    leaf === null ||
    !('tailBuffer' in leaf) ||
    !Array.isArray(leaf.tailBuffer) ||
    !('tailLinesTotal' in leaf) ||
    typeof leaf.tailLinesTotal !== 'number' ||
    !('waitBlockedAt' in leaf)
  ) {
    throw new Error('Runtime leaf has no terminal tail state')
  }
  return leaf
}

describe('pruneDisconnectedPtyTranscript clears the wait-scan cache', () => {
  it('empties the tail and drops tailWaitState so resume recomputes', () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both protected methods are declared on OrcaRuntimeService's inheritance chain.
    const internals = runtime as unknown as RuntimeInternals
    const pty = internals.recordPtyWorktree('pty-1', 'wt-1', { connected: true })

    // Simulate an established, blocked tail with a memoized wait state.
    pty.tailBuffer = ['Update available! Press Enter to continue.']
    pty.tailWaitState = {
      waitText: 'update available! press enter to continue.',
      signal: { reason: 'codex-update-prompt', index: 0 },
      fromTail: true
    }

    pty.connected = false
    internals.pruneDisconnectedPtyTranscript(pty)

    expect(pty.tailBuffer).toEqual([])
    expect(pty.tailWaitState).toBeUndefined()
  })

  it('reuses the real leaf wait scan and stamps each newly arriving blocked prompt', async () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = 'pty-memo'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId: 'tab-1', worktreeId: 'wt-1', title: '', activeLeafId: leafId, layout: null }],
      leaves: [
        { tabId: 'tab-1', worktreeId: 'wt-1', leafId, paneRuntimeId: 1, ptyId, paneTitle: null }
      ]
    })
    const leaf = onlyRuntimeLeaf(runtime)
    // Different retained history exercises the leaf scan rather than the shared PTY-tail path.
    leaf.tailBuffer = ['leaf-only history']
    leaf.tailLinesTotal = 1
    const scan = vi.spyOn(terminalWaitTailState, 'computeTerminalTailWaitState')
    const leafScans = () =>
      scan.mock.calls.filter(([lines]) => lines.includes('leaf-only history')).length
    try {
      runtime.onPtyData(ptyId, 'first plain line\n', 1_000)
      expect(leafScans()).toBe(2)
      expect('tailWaitState' in leaf ? leaf.tailWaitState : undefined).toMatchObject({
        fromTail: true,
        signal: null
      })
      runtime.onPtyData(ptyId, 'second plain line\n', 2_000)
      expect(leafScans()).toBe(3)
      expect(leaf.waitBlockedAt).toBeNull()
      runtime.onPtyData(ptyId, 'Update ava', 3_000)
      expect(leafScans()).toBe(4)
      expect(leaf.waitBlockedAt).toBeNull()
      runtime.onPtyData(ptyId, 'ilable! Press Enter to continue.\n', 4_000)
      expect(leafScans()).toBe(5)
      expect(leaf.waitBlockedAt).toBe(4_000)
      runtime.onPtyData(ptyId, 'ordinary log after the prompt\n', 5_000)
      expect(leafScans()).toBe(6)
      expect(leaf.waitBlockedAt).toBe(4_000)
      runtime.onPtyData(ptyId, 'Update available! Press Enter to continue.\n', 6_000)
      expect(leafScans()).toBe(7)
      expect(leaf.waitBlockedAt).toBe(6_000)
      runtime.onPtyData(
        ptyId,
        Array.from({ length: MAX_TAIL_LINES + 1 }, (_, index) => `streaming line ${index}\n`).join(
          ''
        ),
        7_000
      )
      expect(leaf.tailBuffer).toHaveLength(MAX_TAIL_LINES)
      expect(leaf.tailBuffer).not.toContain('leaf-only history')
      expect('tailWaitState' in leaf ? leaf.tailWaitState : undefined).toMatchObject({
        fromTail: true,
        signal: null
      })
      runtime.onPtyData(ptyId, 'Update available! Press Enter to continue.\n', 8_000)
      expect(leaf.waitBlockedAt).toBe(8_000)
    } finally {
      scan.mockRestore()
      await runtime.onPtyExit(ptyId, 0)
    }
  })
})
