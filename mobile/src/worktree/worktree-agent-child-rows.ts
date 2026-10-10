import { agentChildRowContextForParent } from '../../../src/shared/agent-child-row-model'
import { isAgentStatusFresh } from '../../../src/shared/agent-status-freshness'
import { decodeAgentChildWorkViews } from '../../../src/shared/agent-status-child-work-view-wire'
import { decodeAgentSubagentsField } from '../../../src/shared/agent-status-subagent-snapshot'
import { buildRunningAgentChildRowModels } from '../../../src/shared/running-agent-child-rows'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

/** Catalog rows are opaque on the wire; decode both child sources before presentation/equality. */
export function readWorktreeAgentChildSource(agent: RuntimeWorktreeAgentRow) {
  return {
    children: decodeAgentChildWorkViews(agent.children),
    subagents: decodeAgentSubagentsField(agent.subagents)
  }
}

export function worktreeAgentChildRows(
  agent: RuntimeWorktreeAgentRow,
  now: number,
  live: boolean,
  hostClockOffsetMs: number | undefined
) {
  const offset = hostClockOffsetMs ?? 0
  const parentIsFresh = hostClockOffsetMs !== undefined && isAgentStatusFresh(agent, now - offset)
  const context = agentChildRowContextForParent(
    {
      updatedAt: agent.updatedAt,
      mirroredEvidenceReceivedAt: agent.updatedAt + offset,
      subagentObservation: live ? 'live' : 'unverifiable'
    },
    parentIsFresh
  )
  const source = readWorktreeAgentChildSource(agent)
  // Canonical views use the serving clock; a CLI relay's start clock needs its own calibration.
  const cliOffset = agent.subagentClockOffsetMs
  const elapsedOffset =
    source.children !== undefined
      ? 0
      : typeof cliOffset === 'number' && Number.isFinite(cliOffset)
        ? cliOffset
        : undefined
  const elapsedNow =
    hostClockOffsetMs !== undefined && elapsedOffset !== undefined
      ? now - offset - elapsedOffset
      : undefined
  return {
    rows: buildRunningAgentChildRowModels(source, {
      ...context,
      hostClockOffsetMs: hostClockOffsetMs ?? null
    }),
    elapsedNow
  }
}
