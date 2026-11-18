import { useCallback, useEffect, useState } from 'react'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  workspaceNotificationMutesRead,
  workspaceNotificationMutesWrite
} from './workspace-row-menu-operations'

type Mutes = Readonly<Record<string, boolean>>

/** The paired desktop's per-workspace notification mutes, the map its own row menu toggles. Null: a
 *  desktop too old to keep them (or not read yet), so the phone offers no Mute. */
export function useWorkspaceNotificationMutes(args: {
  client: RpcClient | null
  connState: ConnectionState
  /** Read each time a row menu opens, so a toggle starts from the desktop's latest map. */
  menuOpen: boolean
}) {
  const { client, connState, menuOpen } = args
  // Kept with the client it was read from, so another host's map is never shown.
  const [read, setRead] = useState<{ client: RpcClient; mutes: Mutes | null } | null>(null)
  const [readCount, setReadCount] = useState(0)
  const mutes = read && read.client === client ? read.mutes : null

  useEffect(() => {
    if (!menuOpen || !client || connState !== 'connected') {
      return
    }
    let current = true
    void workspaceNotificationMutesRead
      .request(client)
      .then((reply) => {
        const outcome = workspaceNotificationMutesRead.interpret(reply)
        if (current && outcome.accepted) {
          setRead({ client, mutes: outcome.value })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, connState, menuOpen, readCount])

  const toggleMuted = useCallback(
    (worktreeId: string) => {
      if (!client || !mutes) {
        return
      }
      // As desktop: only a mute is kept; unmuting drops the key.
      const next = { ...mutes }
      if (next[worktreeId] === true) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = true
      }
      setRead({ client, mutes: next })
      void workspaceNotificationMutesWrite
        .request(client, { notificationsMutedByWorktree: next })
        .then((reply) => workspaceNotificationMutesWrite.interpret(reply).accepted)
        .catch(() => false)
        .then((accepted) => {
          // A refusal puts back what the desktop holds.
          if (!accepted) {
            setReadCount((count) => count + 1)
          }
        })
    },
    [client, mutes]
  )

  return { mutes, toggleMuted }
}
