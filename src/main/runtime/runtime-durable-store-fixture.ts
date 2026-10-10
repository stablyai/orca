import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/profile-state-writer-errors'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import {
  admitPaneToSession,
  withdrawPaneFromSession,
  type PaneLayoutChange,
  type TerminalPaneAdmission
} from '../persistence/terminal-topology/terminal-pane-admission'
import type { CommandOf } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Keep runtime fakes on the same reserved, durable-before-ack contract as Store. */
export function withDurableRuntimeStore<
  T extends {
    flushOrThrow?: () => void
    flushPendingOrThrowAsync?: (options?: { drainToStableGeneration?: boolean }) => Promise<void>
  }
>(store: T) {
  let pending = Promise.resolve()
  return Object.assign(store, {
    runDurableMutation<Value>(mutate: () => DurableProfileStateMutation<Value>): Promise<Value> {
      const write = pending.then(async () => {
        const mutation = mutate()
        if (mutation.persist === false) {
          return mutation.value
        }
        try {
          if (store.flushPendingOrThrowAsync) {
            await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
          } else {
            store.flushOrThrow?.()
          }
        } catch (error) {
          if (profileStateWriterFailureOutcome(error) !== 'indeterminate') {
            mutation.rollback?.()
          }
          throw error
        }
        return mutation.value
      })
      pending = write.then(
        () => {},
        () => {}
      )
      return write
    }
  })
}

/** Gives a runtime fake the Store's pane admission, over the fake's own session accessors. */
export function withRuntimePaneAdmission<
  T extends {
    getWorkspaceSession?: (hostId?: string) => WorkspaceSessionState
    setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string) => void
  }
>(store: T) {
  const commit = <V>(
    hostId: string | undefined,
    change: (session: WorkspaceSessionState) => PaneLayoutChange<V>
  ): V => {
    const resolved = resolveHostId(hostId)
    const { value, session } = change(store.getWorkspaceSession!(resolved))
    if (session) {
      store.setWorkspaceSession!(session, resolved)
    }
    return value
  }
  return Object.assign(store, {
    admitTerminalPane: async (admission: TerminalPaneAdmission, hostId?: string) =>
      commit(hostId, (session) => admitPaneToSession(resolveHostId(hostId), session, admission)),
    withdrawTerminalPane: async (pane: CommandOf<'closePane'>, hostId?: string) =>
      commit(hostId, (session) => withdrawPaneFromSession(resolveHostId(hostId), session, pane))
  })
}
