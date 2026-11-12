import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import { subscribeSharedClientEvents } from '../transport/connection/shared-client-events'
import { agentActivitySubjectKey } from '../../../src/shared/agent-activity-read-state'
import { HostActivityReadModel, EMPTY_ACTIVITY_READ_SNAPSHOT } from './host-activity-read-model'
import type { HostActivityRow } from './host-activity-sections'

const emptySnapshot = () => EMPTY_ACTIVITY_READ_SNAPSHOT
const emptySubscription = () => () => {}

export function useHostActivityReadState(args: {
  client: RpcClient | null
  hostId: string | undefined
  connState: ConnectionState
  active: boolean
  onError: (message: string) => void
}) {
  const { client, hostId, connState, active, onError } = args
  const t = useMobileTranslation()
  const model = useMemo(
    () => (client && hostId ? new HostActivityReadModel(client) : null),
    [client, hostId]
  )
  const snapshot = useSyncExternalStore(
    model?.subscribe ?? emptySubscription,
    model?.getSnapshot ?? emptySnapshot
  )
  useEffect(() => {
    if (!model || !client || !active || connState !== 'connected') {
      return
    }
    model.setActive(true)
    void model.refresh(true)
    const stop = subscribeSharedClientEvents(client, (event) => {
      if (event.type === 'agentActivityReadStateChanged' || event.type === 'ready') {
        void model.refresh(event.type === 'ready')
      }
    })
    return () => {
      model.setActive(false)
      stop()
    }
  }, [model, client, active, connState])
  const get = useCallback(
    (row: HostActivityRow) =>
      snapshot.activities.get(
        agentActivitySubjectKey({
          hostId: row.worktree.hostId ?? 'local',
          worktreeId: row.worktree.worktreeId,
          paneKey: row.agent.paneKey
        })
      ),
    [snapshot]
  )
  const setRead = useCallback(
    async (row: HostActivityRow, read: boolean) => {
      const activity = get(row)
      if (!model || !activity) {
        return
      }
      try {
        await model.setRead(activity, read)
      } catch {
        onError(
          t(
            'hostScreen.activity.readError',
            'Could not update notification read status. Try again.'
          )
        )
      }
    },
    [model, get, onError, t]
  )
  return { snapshot, get, setRead }
}
