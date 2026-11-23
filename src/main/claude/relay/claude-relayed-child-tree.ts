import type { ClaudeChildTreeReaper } from '../child-process/claude-agent-sdk-exit-proof'

/** The daemon reaps a relayed agent's group and proves its exit; nothing here walks or signals it. */
export function relayedClaudeChildTree(exited: () => boolean): ClaudeChildTreeReaper {
  return {
    capture: () => Promise.resolve(),
    reap: () => Promise.resolve(exited() ? 'exited' : 'live'),
    get treeVerdict() {
      return exited() ? 'exited' : 'live'
    },
    forcedReapAttempted: false
  }
}
