import { useEffect, useMemo, useRef, useState } from 'react'
import {
  selectConnectableHostProfiles,
  sortHostsByLastConnected
} from '../host-catalog/host-catalog-selection'
import { loadHostCatalog } from '../host-catalog/host-store'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { HostProfile } from '../host-catalog/host-profile'
import { useAllHostClients } from '../transport/connection/use-all-host-clients'
import type { BotLinkHostAnswer } from '../../../src/shared/bots/bot-link-resolution'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import { hostBotsKey } from './host-bots-read'
import { hostConnectionEpoch } from '../query/host-status-query'
import {
  readBotLinkComputerAnswers,
  withoutRelayedTwins,
  type BotLinkComputerAnswer
} from './bot-link-host-reads'

// A link must settle even when a paired computer is asleep; a host silent this long is skipped.
export const BOT_LINK_HOST_WAIT_MS = 10_000

const NO_HOSTS: HostProfile[] = []

/** Every paired host's bots, and each server's it relays, once each paired host has answered or the
 *  wait ran out; null until then. An answer's `hostId` is the computer's `hostBotsKey`. */
export function useBotLinkHostAnswers(): {
  hosts: HostProfile[]
  answers: BotLinkHostAnswer[] | null
  /** Each answering computer by its key: which paired host reaches it, and its server name. */
  computers: ReadonlyMap<string, BotLinkComputerAnswer>
  clientFor: (hostId: string) => RpcClient | null
  failed: boolean
} {
  const [hosts, setHosts] = useState<HostProfile[] | null>(null)
  const [answered, setAnswered] = useState<ReadonlyMap<string, BotLinkComputerAnswer[]>>(new Map())
  const [waitOver, setWaitOver] = useState(false)
  const startedRef = useRef(new Set<string>())
  const discoveries = useRef(new Set<AbortController>())
  const deadlinePassed = useRef(false)
  const catalogLoaded = useRef(false)
  const catalogFailed = useRef(false)
  const hostIds = useMemo(() => (hosts ?? NO_HOSTS).map((host) => host.id), [hosts])
  const clients = useAllHostClients(hostIds)

  useEffect(() => {
    let live = true
    void loadHostCatalog()
      .then((catalog) => sortHostsByLastConnected(selectConnectableHostProfiles(catalog)))
      .catch(() => {
        catalogFailed.current = true
        return NO_HOSTS
      })
      .then((profiles) => {
        if (live && !deadlinePassed.current) {
          catalogLoaded.current = true
          setHosts(profiles)
        }
      })
    const timer = setTimeout(() => {
      deadlinePassed.current = true
      if (!catalogLoaded.current) {
        catalogFailed.current = true
      }
      for (const controller of discoveries.current) {
        controller.abort()
      }
      setWaitOver(true)
      setHosts((known) => known ?? NO_HOSTS)
    }, BOT_LINK_HOST_WAIT_MS)
    return () => {
      live = false
      clearTimeout(timer)
      for (const controller of discoveries.current) {
        controller.abort()
      }
    }
  }, [])

  // `clients` is rebuilt on every connection tick; reads outlive those renders, so only unmount drops them.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const record = (hostId: string, answers: BotLinkComputerAnswer[]) => {
      if (mountedRef.current) {
        setAnswered((previous) => new Map(previous).set(hostId, answers))
      }
    }
    for (const entry of clients) {
      if (deadlinePassed.current || startedRef.current.has(entry.hostId)) {
        continue
      }
      if (entry.state === 'auth-failed') {
        startedRef.current.add(entry.hostId)
        record(entry.hostId, [unreachable(entry.hostId)])
      } else if (entry.state === 'connected') {
        startedRef.current.add(entry.hostId)
        const controller = new AbortController()
        discoveries.current.add(controller)
        const epoch = hostConnectionEpoch(entry.client)
        void readBotLinkComputerAnswers(entry.client, entry.hostId, { signal: controller.signal })
          .then((answers) => {
            if (!controller.signal.aborted && hostConnectionEpoch(entry.client) === epoch) {
              record(entry.hostId, answers)
            }
          })
          .finally(() => discoveries.current.delete(controller))
      }
    }
  }, [clients])

  const computers = useMemo(
    () =>
      new Map(
        withoutRelayedTwins(
          (hosts ?? NO_HOSTS).flatMap((host) => answered.get(host.id) ?? [unreachable(host.id)])
        ).map((entry) => [entry.key, entry])
      ),
    [hosts, answered]
  )
  const answers = useMemo(() => {
    if (hosts === null) {
      return null
    }
    if (!waitOver && hosts.some((host) => !answered.has(host.id))) {
      return null
    }
    return [...computers.values()].map(({ key, answer }) => ({ hostId: key, answer }))
  }, [hosts, answered, waitOver, computers])

  const clientFor = (hostId: string) =>
    clients.find((entry) => entry.hostId === hostId)?.client ?? null
  return { hosts: hosts ?? NO_HOSTS, answers, computers, clientFor, failed: catalogFailed.current }
}

function unreachable(pairedHostId: string): BotLinkComputerAnswer {
  return {
    key: hostBotsKey(pairedHostId),
    pairedHostId,
    executionHost: LOCAL_EXECUTION_HOST_ID,
    answer: { kind: 'unreachable' }
  }
}
