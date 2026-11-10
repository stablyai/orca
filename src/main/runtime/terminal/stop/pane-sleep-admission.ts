import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'
import {
  type PaneSleepStopCondition,
  paneSleepSourceIsCurrent,
  type PaneSleepTarget
} from '../../../../shared/agent-session/lifecycle/pane-sleep-target'
import type { OwnedPaneAgentRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { tryGetProviderForPty } from '../../../ipc/pty/provider/registry'
import { ptyIncarnationById } from '../../../ipc/pty/provider/ownership-state'
import { inspectPtyProviderProcess } from '../../../providers/pty-process-inspection'

/** Inspection proves identity; the callback rechecks the authority after durable-write waits. */
export async function preparePaneSleepAdmission(
  targets: readonly PaneSleepTarget[]
): Promise<() => boolean> {
  const checks = await Promise.all(
    targets.map(async (target) => {
      const provider = tryGetProviderForPty(target.ptyId)
      if (!provider) {
        return () => false
      }
      const inspection = await inspectPtyProviderProcess(provider, target.ptyId, {
        foregroundOnly: true,
        expectedIncarnationId: target.ptyIncarnationId
      }).catch(() => null)
      const observation = inspection?.foregroundObservation
      const matches =
        observation?.verdict === 'observed' &&
        observation.ptyId === target.ptyId &&
        observation.ptyIncarnationId === target.ptyIncarnationId &&
        observation.authorityGeneration === target.authorityGeneration
      return () =>
        matches &&
        tryGetProviderForPty(target.ptyId) === provider &&
        ptyIncarnationById.get(target.ptyId) === target.ptyIncarnationId
    })
  )
  return () => checks.every((check) => check())
}

export function paneSleepTargetMatches(
  workspace: string,
  target: PaneSleepTarget,
  pty: RuntimePtyWorktreeRecord | null,
  source: AgentStatusEntry | null
): boolean {
  return (
    pty?.connected === true &&
    pty.ptyId === target.ptyId &&
    pty.incarnationId === target.ptyIncarnationId &&
    pty.worktreeId === workspace &&
    paneSleepSourceIsCurrent(target, source)
  )
}

export function paneSleepStopMatches(
  condition: PaneSleepStopCondition,
  current: boolean,
  saved: OwnedPaneAgentRecord | undefined
): boolean {
  return (
    current &&
    (!condition.record || structuralValuesEqualIgnoringUndefined(saved, condition.record))
  )
}
