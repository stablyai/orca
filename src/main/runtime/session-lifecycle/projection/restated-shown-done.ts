import { agentStatusAuthorityObservedAt } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  pickHostTurnEnd,
  type HostTurnEndFacts
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeAgentRowSnapshot } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import type { HookLiveAgentRow } from '../../workspaces/process-listing/hook-live-agent-row'

/** The identity a title-derived Done keeps when it only restates the shown Done: null once a title turn started after it. */
export function restatedShownDone(
  segment: HookLiveAgentRow | RuntimeAgentRowSnapshot | AgentStatusIpcPayload | null,
  titleWorkingStartedAt: number | null
):
  | (HostTurnEndFacts & {
      stateStartedAt: number
      turnCompletedAt?: number
      sessionBoundary?: true
    })
  | null {
  const payload = segment && 'payload' in segment ? segment.payload : segment
  if (!segment || payload?.state !== 'done') {
    return null
  }
  // Host evidence time shares the title's clock, unlike relay turn stamps, and survives replays.
  const observedAt = agentStatusAuthorityObservedAt(
    'payload' in segment
      ? segment
      : { updatedAt: segment.receivedAt, evidenceObservedAt: segment.evidenceObservedAt }
  )
  if (titleWorkingStartedAt !== null && titleWorkingStartedAt > observedAt) {
    return null
  }
  return {
    stateStartedAt: segment.stateStartedAt,
    ...pickHostTurnEnd(segment),
    ...(payload.turnCompletedAt !== undefined ? { turnCompletedAt: payload.turnCompletedAt } : {}),
    ...(payload.sessionBoundary === true ? { sessionBoundary: true } : {})
  }
}
