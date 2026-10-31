import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../../shared/process-table-index'
import {
  capturePaneAgentStopRelease,
  paneAgentStopReleaseAdmits,
  type PaneProcessIdentity
} from '../../pty/pane-agent-stop-release'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

export function prepareTerminalAgentStopRelease(input: {
  pty: RuntimePtyWorktreeRecord
  agent: string
  providerSessionId: string
  current: () => boolean
  rows: readonly ProcessTableRow[]
  readRows: () => Promise<ProcessTableRow[]>
  root: PaneProcessIdentity
  shell: PaneProcessIdentity
  stopRoot: PaneProcessIdentity
  observedAgent: PaneProcessIdentity
  platform: 'posix' | 'win32'
}) {
  const release = capturePaneAgentStopRelease(input.rows, { ...input, agent: input.stopRoot })
  return {
    released: async (predict = false) => {
      const rows = await input.readRows()
      const excluded = new Set<number>()
      if (predict) {
        const index = buildProcessTableIndex(rows)
        const target = index.byPid.get(input.stopRoot.pid)
        if (target && target.startTime !== input.stopRoot.startTime) {
          return false
        }
        if (target) {
          excluded.add(target.pid)
          collectDescendantsFromIndex(index, target.pid).forEach((row) => excluded.add(row.pid))
        }
      }
      return input.current() && paneAgentStopReleaseAdmits(rows, release, excluded)
    },
    commitRelease: () => {
      if (!input.current()) {
        throw new Error('pane changed before release')
      }
      input.pty.cliAgentStopRelease = {
        incarnationId: input.pty.incarnationId,
        agent: input.agent,
        providerSessionId: input.providerSessionId,
        stopped: input.observedAgent,
        proof: release
      }
    }
  }
}
