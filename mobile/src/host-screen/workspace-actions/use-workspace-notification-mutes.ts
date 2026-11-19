import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  workspaceNotificationMutesRead,
  workspaceNotificationMutesWrite
} from './workspace-row-menu-operations'

type Mutes = Readonly<Record<string, boolean>>

async function readMutes(client: RpcClient): Promise<Mutes | null | undefined> {
  const outcome = workspaceNotificationMutesRead.interpret(
    await workspaceNotificationMutesRead.request(client)
  )
  return outcome.accepted ? outcome.value : undefined
}

/** The paired desktop's per-workspace notification mutes, the map its own row menu toggles. Null: a
 *  desktop too old to keep them (or not read yet), so the phone offers no Mute. */
export function useWorkspaceNotificationMutes(args: {
  client: RpcClient | null
  connState: ConnectionState
  /** Read each time a row menu opens, for the label. */
  menuOpen: boolean
}) {
  const { client, connState, menuOpen } = args
  // Kept with the client it was read from, so another host's map is never shown.
  const [read, setRead] = useState<{ client: RpcClient; mutes: Mutes | null } | null>(null)
  const mutes = read && read.client === client ? read.mutes : null
  // Each toggle reads then replaces the whole map, so toggles run one after another.
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!menuOpen || !client || connState !== 'connected') {
      return
    }
    let current = true
    void readMutes(client)
      .then((value) => {
        if (current && value !== undefined) {
          setRead({ client, mutes: value })
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, connState, menuOpen])

  const setMuted = useCallback(
    (worktreeId: string, muted: boolean) => {
      if (!client) {
        return
      }
      // The write replaces the desktop's whole map, so it starts from a fresh read, not the menu's copy.
      queueRef.current = queueRef.current
        .then(() => readMutes(client))
        .then(async (fresh) => {
          if (!fresh) {
            return
          }
          // As desktop: only a mute is kept; unmuting drops the key.
          const next = { ...fresh }
          if (muted) {
            next[worktreeId] = true
          } else {
            delete next[worktreeId]
          }
          const reply = await workspaceNotificationMutesWrite.request(client, {
            notificationsMutedByWorktree: next
          })
          if (workspaceNotificationMutesWrite.interpret(reply).accepted) {
            setRead({ client, mutes: next })
          }
        })
        .catch(() => {})
    },
    [client]
  )

  return { mutes, setMuted }
}
