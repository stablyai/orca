// Home's rows for the agents shared with each paired computer's account. The phone follows each
// computer's shares when it connects, and reads an agent's row (its avatar and last activity) from its
// host each time the phone's link to it comes up; the rows change only when one of those does.
import { useEffect, useMemo, useState } from 'react'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'
import { phoneSharedAgents } from '../../bots/shared-agents/phone-shared-agents'
import { routeSharedAgentCalls } from '../../bots/shared-agents/shared-agent-call-routing'
import { mobileBotAvatarSource } from '../../bots/host-bot-row-facts'
import { hostBotsKey } from '../../bots/host-bots-read'
import { readSharedAgentBot } from '../../bots/shared-agents/shared-agent-bot-read'
import type { PhoneBot } from '../../bots/host-bots-operations'
import { translate } from '../../i18n/mobile-i18n'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HomeBotRow } from './home-bot-row-views'

type Host = { hostId: string; client: RpcClient | null }

/** The row of one shared agent: its host's read of it where there is one. */
export function homeSharedAgentRow(
  pairedHostId: string,
  view: SharedBotHostView,
  bot: PhoneBot | undefined
): Extract<HomeBotRow, { kind: 'shared' }> {
  const executionHost: ExecutionHostId = toRuntimeExecutionHostId(view.environmentId)
  const offline = view.link !== 'live'
  return {
    kind: 'shared',
    key: `shared:${pairedHostId}:${view.environmentId}`,
    computerKey: hostBotsKey(pairedHostId, executionHost),
    pairedHostId,
    executionHost,
    environmentId: view.environmentId,
    hostLabel: view.ownerName,
    title: bot?.name ?? view.botName,
    preview: translate('bots.share.sharedBy', 'Shared by {{name}}', { name: view.ownerName }),
    age: null,
    unread: false,
    needsYou: 0,
    activityAt: bot?.updatedAt ?? 0,
    avatar: mobileBotAvatarSource(bot ?? { id: view.botId, name: view.botName, avatar: null }),
    dot: offline ? 'inactive' : null,
    ...(offline ? { offline: true as const } : {})
  }
}

export function useHomeSharedAgentRows(
  hosts: readonly Host[],
  hostStates: Readonly<Record<string, ConnectionState>>
): readonly HomeBotRow[] {
  const connected = useMemo(
    () => hosts.filter((host) => host.client && hostStates[host.hostId] === 'connected'),
    [hosts, hostStates]
  )
  // Each connect is when the computer's shares (and this phone's keys to them) are followed.
  useEffect(() => {
    for (const host of connected) {
      void phoneSharedAgents().syncComputer(host.hostId, host.client!)
    }
  }, [connected])
  const [views, setViews] = useState<ReadonlyMap<string, SharedBotHostView[]>>(new Map())
  const hostIds = useMemo(() => hosts.map((host) => host.hostId).join('\n'), [hosts])
  useEffect(() => {
    const stop = watchComputers(hostIds.split('\n').filter(Boolean), (hostId, next) =>
      setViews((shown) => new Map(shown).set(hostId, next))
    )
    return () => stop()
  }, [hostIds])
  const bots = useSharedAgentBots(hosts, views)
  return useMemo(
    () =>
      [...views].flatMap(([hostId, shown]) =>
        shown.map((view) => homeSharedAgentRow(hostId, view, bots.get(view.shareId)))
      ),
    [views, bots]
  )
}

/** Follows each computer's shared agents; the returned function stops them all. */
function watchComputers(
  hostIds: readonly string[],
  onViews: (hostId: string, views: SharedBotHostView[]) => void
): () => void {
  const stops = hostIds.map((hostId) =>
    phoneSharedAgents().watch(hostId, (next) => onViews(hostId, next))
  )
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}

/** Each live shared agent's own read of itself, taken when its link comes up. */
function useSharedAgentBots(
  hosts: readonly Host[],
  views: ReadonlyMap<string, SharedBotHostView[]>
): ReadonlyMap<string, PhoneBot> {
  const [bots, setBots] = useState<ReadonlyMap<string, PhoneBot>>(new Map())
  const live = useMemo(
    () =>
      [...views].flatMap(([hostId, shown]) =>
        shown.filter((view) => view.link === 'live').map((view) => ({ hostId, view }))
      ),
    [views]
  )
  const liveKey = live.map(({ hostId, view }) => `${hostId}:${view.shareId}`).join('\n')
  useEffect(() => {
    let current = true
    for (const { hostId, view } of live) {
      const client = hosts.find((host) => host.hostId === hostId)?.client
      if (!client) {
        continue
      }
      const routed = routeSharedAgentCalls(client, hostId, phoneSharedAgents())
      void readSharedAgentBot(routed, hostId, view).then((bot) => {
        if (current && bot) {
          setBots((shown) => new Map(shown).set(view.shareId, bot))
        }
      })
    }
    return () => {
      current = false
    }
    // Read again only when which agents are live changes.
  }, [liveKey])
  return bots
}
