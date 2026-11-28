import { useEffect, useMemo, useState } from 'react'
import { withoutRelayedTwins } from '../bots/bot-link-host-reads'
import { homeBotsQuery } from '../home/bots/home-bots-query'
import { loadHostCatalog } from '../host-catalog/host-store'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../host-screen/catalog/host-list-queries'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostQuery } from '../query/host-query'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { hostAnswersToRailBotsSource, type RailBotsSource } from './rail-bot-targets'

/** One paired host's bots (and its relayed servers') for the Duo shell rail and iPad usage rail. */
export function useHostRailBotsSource(hostId: string | null): RailBotsSource | null {
  const t = useMobileTranslation()
  const fallbackHostName = t('bots.items.thisComputer', 'The computer')
  const { client, state } = useHostClient(hostId ?? undefined)
  const [hostLabel, setHostLabel] = useState('')
  const online = hostId !== null && state === 'connected' && client !== null
  const query = useHostQuery(
    homeBotsQuery,
    { hostId: hostId ?? '', client: hostId ? client : null },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { enabled: online }
  )

  useEffect(() => {
    if (!hostId) {
      return
    }
    let live = true
    void loadHostCatalog()
      .then((catalog) => {
        if (!live) {
          return
        }
        const matched = catalog.find((entry) => entry.id === hostId)
        setHostLabel(matched?.name ?? '')
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [hostId])

  const hostName = hostLabel || fallbackHostName
  const rawAnswers = query.data?.answers ?? null

  return useMemo(() => {
    if (!hostId) {
      return null
    }
    if (!rawAnswers) {
      return {
        targets: [],
        needsYou: 0,
        loading: online && query.isPending,
        online,
        hostName
      }
    }
    return hostAnswersToRailBotsSource({
      answers: withoutRelayedTwins(rawAnswers),
      client,
      online,
      hostName,
      fallbackHostName
    })
  }, [hostId, rawAnswers, client, online, query.isPending, hostName, fallbackHostName])
}
