import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** A runtime whose single tab leaf is bound to `ptyId`, so onPtyData updates PTY and leaf tails. */
export function runtimeWithLeaf(ptyId: string): {
  runtime: OrcaRuntimeService
  leaf: RuntimeLeafRecord
} {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: 'tab-1', worktreeId: 'wt-1', activeLeafId: LEAF_ID, layout: null, title: '' }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: null
      }
    ]
  })
  const leaves = runtime['leaves']
  const leaf = leaves.values().next().value
  if (leaves.size !== 1 || !leaf) {
    throw new Error('Expected exactly one runtime leaf')
  }
  return { runtime, leaf }
}

export function readPtyTail(runtime: OrcaRuntimeService, ptyId: string): string[] {
  const lines = runtime['ptysById'].get(ptyId)?.tailBuffer
  if (!lines) {
    throw new Error('PTY record has no tail')
  }
  return lines.map(String)
}
