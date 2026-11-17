import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

type SleepingRecordStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'patchWorkspaceSession' | 'runDurableMutation'
>

/** Durably removes one pane's saved resume when `retire` accepts it; a failed write restores only that record. */
export async function removeSleepingRecordDurably(
  store: SleepingRecordStore | null | undefined,
  hostId: ExecutionHostId,
  paneKey: string,
  retire: (saved: SleepingAgentSessionRecord) => boolean
): Promise<void> {
  const getSession = store?.getWorkspaceSession?.bind(store)
  const patchSession = store?.patchWorkspaceSession?.bind(store)
  if (!getSession || !patchSession || !store?.runDurableMutation) {
    throw new Error('workspace_session_unavailable')
  }
  const read = (): Record<string, SleepingAgentSessionRecord> | undefined =>
    getSession(hostId)?.sleepingAgentSessionsByPaneKey
  const patch = (records: Record<string, SleepingAgentSessionRecord>): void =>
    patchSession({ sleepingAgentSessionsByPaneKey: records }, hostId)
  await store.runDurableMutation(() => {
    const records = read()
    const removed = records?.[paneKey]
    if (!records || !removed || !retire(removed)) {
      return { value: undefined, persist: false }
    }
    const { [paneKey]: _removed, ...kept } = records
    patch(kept)
    return {
      value: undefined,
      rollback: () => {
        const current = read() ?? {}
        if (!Object.hasOwn(current, paneKey)) {
          patch({ ...current, [paneKey]: removed })
        }
      }
    }
  })
}
