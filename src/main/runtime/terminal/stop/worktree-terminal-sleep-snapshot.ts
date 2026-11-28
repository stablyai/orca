import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import type { PtyList } from '../records/runtime-terminal-state-records'
import { hostSleepKey, listSleepWorkspaceId } from './worktree-terminal-sleep-key'
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

  /** `target` is the spawn's own workspace copy: the host whose provider runs it. */
  async acquireWorktreeTerminalSpawn(
    target: HostWorktreeTarget | undefined,
    opts: { refuseSleptWorktree?: boolean; list?: PtyList } = {}
  ): Promise<() => void> {
    if (!target) {
      return () => {}
    }
    const worktreeId = target.id
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'shared')
    const key = hostSleepKey(target.hostId, listSleepWorkspaceId(worktreeId, opts.list))
    const sleepState = this.terminalSleepStateByHostWorktree.get(key)
    // Why: re-checked under the lock, since a sleep can commit while an automatic spawn waits for it.
    if (sleepState && opts.refuseSleptWorktree) {
      release()
      throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
    }
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByHostWorktree.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }
}
