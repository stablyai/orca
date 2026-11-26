import { useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { AgentListRow } from '../agents/agent-list-rows'
import type { CommanderMobileData } from '../commander/commander-mobile-data'
import { MobileCommander } from '../commander/MobileCommander'
import { useNow } from '../hooks/use-now'
import { useHostQuery } from '../query/host-query'
import { isHostNotConnectedError } from '../query/host-query-errors'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { homeWorktreeCountsQuery } from '../worktree/catalog/home-host-worktree-fetch'
import { homeWorktreeInfo } from '../worktree/catalog/home-worktree-info'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from './catalog/host-list-queries'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { HostScreenController } from './use-host-screen-controller'

// A host-served document can talk to exactly one paired computer. Its Commander uses only
// that host's catalog and connection, even on a phone with several saved pairings.
export default function HostCommanderScreen({
  controller: {
    hostId,
    client,
    connState,
    hostDisplay,
    lastConnectedAt,
    displayWorktrees,
    actions
  },
  active: visible,
  onClose
}: {
  controller: HostScreenController
  active: boolean
  onClose: () => void
}) {
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const active = visible && focused
  const openSession = useOpenMobileSession()
  const query = useHostQuery(
    homeWorktreeCountsQuery,
    { hostId, client },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    {
      enabled: active && connState === 'connected',
      subscribed: active
    }
  )
  const now = useNow(30_000, active)
  const { data: counts, dataUpdatedAt, error, isError } = query
  const hostName = hostDisplay.title
  const data = useMemo<CommanderMobileData>(() => {
    const sortedHosts = [{ id: hostId, name: hostName }]
    const hostStates = { [hostId]: connState }
    const info = homeWorktreeInfo(
      hostId,
      {
        data: counts,
        dataUpdatedAt,
        failed: isError && !isHostNotConnectedError(error)
      },
      (_id, readAt) => lastConnectedAt !== null && readAt >= lastConnectedAt
    )
    return {
      agentList: {
        hosts: sortedHosts,
        hostStates,
        worktreeInfo: info ? { [hostId]: info } : {},
        now
      },
      sortedHosts,
      allClients: client ? [{ hostId, client }] : [],
      hostStates
    }
  }, [
    hostId,
    hostName,
    connState,
    client,
    now,
    counts,
    dataUpdatedAt,
    error,
    isError,
    lastConnectedAt
  ])
  const onOpen = useCallback(
    (row: AgentListRow) => {
      if (row.hostId !== hostId || row.offline) {
        return
      }
      const target = displayWorktrees.find(
        (worktree) =>
          worktree.worktreeId === row.entry.worktreeId &&
          (worktree.hostId ?? 'local') === (row.entry.hostId ?? 'local')
      )
      if (target) {
        actions.openWorktreeSession(target, row.entry.agent.paneKey)
      } else if (!row.entry.hostId || row.entry.hostId === 'local') {
        // A local agent may appear before the workspace list consumes the same change.
        openSession({
          hostId,
          worktreeId: row.entry.worktreeId,
          name: row.entry.workspaceName,
          paneKey: row.entry.agent.paneKey
        })
      }
    },
    [actions, displayWorktrees, hostId, openSession]
  )
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <MobileCommander
        onExit={onClose}
        hostScoped
        data={data}
        handlers={{ onOpen }}
        active={active}
      />
    </SafeAreaView>
  )
}
