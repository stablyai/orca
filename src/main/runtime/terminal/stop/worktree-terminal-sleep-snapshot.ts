import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { OrcaRuntimeWithSleepResolvedWorktreeTerminals } from './worktree-terminal-sleep'

export abstract class OrcaRuntimeWithTerminalSleepSnapshot extends OrcaRuntimeWithSleepResolvedWorktreeTerminals {
  getTerminalSleepClientEventSnapshot(): RuntimeClientEvent[] {
    const events: RuntimeClientEvent[] = []
    const sleepStates = [...this.terminalSleepStateByHostWorktree.values()].sort((a, b) =>
      a.worktreeId.localeCompare(b.worktreeId)
    )
    for (const state of sleepStates) {
      const committedPtyIds = new Set(state.ptyIds)
      if (state.phase === 'stopping') {
        const pendingPtyIds = Object.keys(state.terminalHandlesByPtyId)
          .filter((ptyId) => !committedPtyIds.has(ptyId))
          .sort()
        if (pendingPtyIds.length > 0) {
          events.push({
            type: 'worktreeTerminalSleepState',
            worktreeId: state.worktreeId,
            generation: state.generation,
            phase: 'started',
            ptyIds: pendingPtyIds,
            terminalHandles: this.getRecordedTerminalSleepHandles(
              pendingPtyIds,
              state.terminalHandlesByPtyId
            )
          })
        }
      }
      if (state.ptyIds.length > 0) {
        events.push({
          type: 'worktreeTerminalSleepState',
          worktreeId: state.worktreeId,
          generation: state.generation,
          phase: 'committed',
          ptyIds: [...state.ptyIds].sort(),
          terminalHandles: this.getRecordedTerminalSleepHandles(
            state.ptyIds,
            state.terminalHandlesByPtyId
          )
        })
      }
    }
    return events
  }
}
