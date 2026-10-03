import type { RuntimeTerminalInteractiveWait } from '../../shared/runtime-types'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

/**
 * Resolves the richer human-wait signal for every row source that names the terminal handle it
 * was observed under, so one `worktree ps` sweep answers what `terminal show` would without a
 * second call per lane. The getter's prompt-text and title branches are pure state reads; only
 * its hook branch probes, deduped once per PTY and bounded by its probe timeout.
 */
export async function attachRuntimeWorktreeAgentRowWaits(
  rowSources: ReadonlyMap<string, RuntimeWorktreeAgentSource>,
  getTerminalInteractiveWait: (
    handle: string
  ) => Promise<RuntimeTerminalInteractiveWait | null | undefined>
): Promise<ReadonlyMap<string, RuntimeWorktreeAgentSource>> {
  const sources = await Promise.all(
    [...rowSources.values()].map(async (source) => {
      if (source.terminalHandle === undefined) {
        return source
      }
      const agentWait = await getTerminalInteractiveWait(source.terminalHandle)
      // Undefined means the lookup could not evaluate (terminal gone, probe timed out), so the
      // row keeps the field absent rather than claiming a verdict.
      return agentWait === undefined ? source : { ...source, agentWait }
    })
  )
  return new Map(sources.map((source) => [source.paneKey, source]))
}
