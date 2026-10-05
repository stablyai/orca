import { startSpan } from '../../observability/tracer'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit
} from '../../runtime/terminal-surface-close'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

// The commit boundary for terminal layout (tabs, panes, pane-to-PTY bindings). Today it wraps only
// the close, whose transform still lives in runtime/; the other writers move here later.

/** Bindings are not listed: `persistPtyBinding` already records `persistence.pty-binding`. */
type TerminalTopologyCommitKind = 'close_leaf' | 'close_tab'

export function closeLeafOrTab(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  return traced(
    commit.target.kind === 'pane' ? 'close_leaf' : 'close_tab',
    terminalSurfaceCloseMutation(commit),
    // Refusals are fixed reason codes, never ids.
    (refusal) => refusal?.message
  )
}

/**
 * One `persistence.terminal-topology` span per commit, from admission to the in-memory write.
 * Attributes stay low-cardinality: no pane key, PTY id or path.
 */
function traced<T>(
  kind: TerminalTopologyCommitKind,
  mutate: () => DurableProfileStateMutation<T>,
  refusalOf: (value: T) => string | undefined
): () => DurableProfileStateMutation<T> {
  return () => {
    const span = startSpan('persistence.terminal-topology', {
      attributes: { kind: 'persistence', 'topology.kind': kind }
    })
    let result: DurableProfileStateMutation<T>
    // Why only mutate(): `threw` must mean the write failed, never that tracing did.
    try {
      result = mutate()
    } catch (error) {
      span.setAttribute('topology.outcome', 'threw')
      span.fail(error instanceof Error ? error : String(error))
      throw error
    }
    const refusal = refusalOf(result.value)
    if (refusal !== undefined) {
      span.setAttribute('topology.outcome', 'refused')
      span.setAttribute('topology.refusal', refusal)
    } else {
      span.setAttribute('topology.outcome', result.persist === false ? 'noop' : 'committed')
    }
    span.end()
    return result
  }
}
