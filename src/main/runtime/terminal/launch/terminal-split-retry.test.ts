import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { TerminalSplitOutcomeError } from '../../../../shared/terminal-split-outcome'

const WORKTREE_ID = 'repo-1::/workspace'
const TAB_ID = 'tab-1'
const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'

type Leaf = { leafId: string; paneRuntimeId: number; ptyId: string | null }

function createHarness() {
  const rendererSplitTerminal = vi.fn()
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split path calls only splitTerminal on the notifier.
  runtime.setNotifier({ splitTerminal: rendererSplitTerminal } as never)
  const publish = (extra: Leaf[] = []): void => {
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: SOURCE_LEAF_ID,
          layout: { type: 'leaf', leafId: SOURCE_LEAF_ID }
        }
      ],
      leaves: [{ leafId: SOURCE_LEAF_ID, paneRuntimeId: 1, ptyId: 'pty-source' }, ...extra].map(
        (leaf) => ({ tabId: TAB_ID, worktreeId: WORKTREE_ID, ...leaf })
      )
    })
  }
  publish()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: issueHandle and leaves are protected; the test issues the source handle as a graph reader would.
  const internals = runtime as unknown as {
    issueHandle: (leaf: unknown) => string
    leaves: Map<string, unknown>
  }
  const handle = internals.issueHandle([...internals.leaves.values()][0])
  return { runtime, handle, rendererSplitTerminal, publish }
}

async function timedOutSplit(harness: ReturnType<typeof createHarness>): Promise<{
  error: TerminalSplitOutcomeError
  leafId: string
}> {
  const split = harness.runtime
    .splitTerminal(harness.handle, { command: 'agent --task 1' })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(10_000)
  const error = await split
  if (!(error instanceof TerminalSplitOutcomeError)) {
    throw new Error(`expected a pending split, got ${String(error)}`)
  }
  return { error, leafId: error.data.splitId }
}

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'window-made split that outlives its wait (#32169)',
  () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('keeps waiting for a pane the window already listed while its terminal starts', async () => {
      const harness = createHarness()
      const split = harness.runtime.splitTerminal(harness.handle, { command: 'agent' })
      const leafId = harness.rendererSplitTerminal.mock.calls[0]?.[2]?.newLeafId
      harness.publish([{ leafId, paneRuntimeId: 2, ptyId: null }])
      await vi.advanceTimersByTimeAsync(15_000)
      harness.publish([{ leafId, paneRuntimeId: 2, ptyId: 'pty-late' }])

      await expect(split).resolves.toMatchObject({
        leafId,
        handle: expect.stringMatching(/^term_/)
      })
    })

    it('a retry returns the late pane without asking the window to split again', async () => {
      const harness = createHarness()
      const { leafId } = await timedOutSplit(harness)
      harness.publish([{ leafId, paneRuntimeId: 2, ptyId: 'pty-late' }])

      await expect(
        harness.runtime.splitTerminal(harness.handle, { retrySplit: leafId })
      ).resolves.toMatchObject({ leafId, tabId: TAB_ID })
      expect(harness.rendererSplitTerminal).toHaveBeenCalledTimes(1)
    })

    it('a retry before the pane appears waits for it without asking the window again', async () => {
      const harness = createHarness()
      const { leafId } = await timedOutSplit(harness)

      const retry = harness.runtime.splitTerminal(harness.handle, { retrySplit: leafId })
      harness.publish([{ leafId, paneRuntimeId: 2, ptyId: 'pty-late' }])

      await expect(retry).resolves.toMatchObject({ leafId })
      expect(harness.rendererSplitTerminal).toHaveBeenCalledTimes(1)
    })

    it('a retry for a pane missing from the graph answers pending, never splitting again', async () => {
      const harness = createHarness()
      const { leafId } = await timedOutSplit(harness)
      harness.publish([{ leafId, paneRuntimeId: 2, ptyId: null }])
      // Absent again: closed or remounting, main cannot tell, so it must not claim either.
      harness.publish()

      const retry = harness.runtime
        .splitTerminal(harness.handle, { retrySplit: leafId })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(retry).resolves.toMatchObject({
        data: { splitId: leafId, splitMayStillComplete: true }
      })
      await expect(
        harness.runtime.splitTerminal(harness.handle, {
          retrySplit: '22222222-2222-4222-8222-222222222222'
        })
      ).rejects.toThrow('no record of split')
      expect(harness.rendererSplitTerminal).toHaveBeenCalledTimes(1)
    })
  }
)
