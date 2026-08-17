// Reads every connected desktop's workspace catalog for the merged Projects home.
//
// One desktop failing is normal (a laptop asleep, a relay dropping), so each is
// fetched independently and a failure falls back to that desktop's proven cache
// instead of emptying the list.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { getProvenCachedWorkspaceCatalog, setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import type { TransientHostClientLease } from '../transport/transient-host-client'
import { sendSingleFlightRequest } from '../transport/request-single-flight'
import type { DesktopWorkspaceCatalog } from './merged-desktop-workspaces'
import type { RepoSummary } from './host-worktree-rpc-types'
import { WORKTREE_PS_FULL_LIMIT } from './worktree-catalog-snapshot-client'
import { readMergedRepoCatalog, readMergedWorktreeCatalog } from './merged-desktop-catalog-response'

export type DesktopClient = {
  hostId: string
  hostName: string
  client: RpcClient | null
  state: ConnectionState
  availableOnDemand?: boolean
  profile?: HostProfile
  acquireClient?: (
    host: HostProfile,
    signal?: AbortSignal,
    onClientOwned?: (client: RpcClient) => void
  ) => Promise<TransientHostClientLease | null>
}

type CatalogsByHostId = Record<string, DesktopWorkspaceCatalog>

const clientIdentities = new WeakMap<RpcClient, number>()
let nextClientIdentity = 1
const profileIdentities = new WeakMap<HostProfile, number>()
let nextProfileIdentity = 1

function clientIdentity(client: RpcClient): number {
  const existing = clientIdentities.get(client)
  if (existing !== undefined) {
    return existing
  }
  const identity = nextClientIdentity++
  clientIdentities.set(client, identity)
  return identity
}

function profileIdentity(profile: HostProfile | undefined): number {
  if (!profile) {
    return 0
  }
  const existing = profileIdentities.get(profile)
  if (existing !== undefined) {
    return existing
  }
  const identity = nextProfileIdentity++
  profileIdentities.set(profile, identity)
  return identity
}

function cachedCatalog(hostId: string, hostName: string): DesktopWorkspaceCatalog | null {
  const worktrees = getProvenCachedWorkspaceCatalog(hostId)
  if (!worktrees) {
    return null
  }
  const repos = readMergedRepoCatalog({
    repos: getCachedRepos(hostId, { allowStale: true }) ?? []
  })
  return {
    desktopHostId: hostId,
    desktopHostName: hostName,
    worktrees,
    repos: repos ?? []
  }
}

async function fetchCatalog(
  desktop: DesktopClient,
  client: RpcClient
): Promise<DesktopWorkspaceCatalog | null> {
  const worktreeResponse = await sendSingleFlightRequest(client, desktop.hostId, 'worktree.ps', {
    limit: WORKTREE_PS_FULL_LIMIT
  })
  if (!worktreeResponse.ok) {
    return null
  }
  const worktrees = readMergedWorktreeCatalog(worktreeResponse.result)
  if (!worktrees) {
    return null
  }
  // Repo metadata only decorates rows and resolves the execution host of older
  // payloads, so a failure here must not discard the workspaces we just proved.
  let repos: RepoSummary[] = []
  try {
    const repoResponse = await client.sendRequest('repo.list')
    const receivedRepos = repoResponse.ok ? readMergedRepoCatalog(repoResponse.result) : null
    repos = receivedRepos ?? cachedRepos(desktop.hostId)
  } catch {
    repos = cachedRepos(desktop.hostId)
  }

  return {
    desktopHostId: desktop.hostId,
    desktopHostName: desktop.hostName,
    worktrees,
    repos
  }
}

function cachedRepos(hostId: string): RepoSummary[] {
  return readMergedRepoCatalog({ repos: getCachedRepos(hostId, { allowStale: true }) ?? [] }) ?? []
}

function subscribeToCatalogChanges(
  desktop: DesktopClient & { client: RpcClient },
  refresh: () => void
): () => void {
  let ready = false
  return desktop.client.subscribe('runtime.clientEvents.subscribe', null, (payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return
    }
    const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
    if (event.type === 'ready') {
      if (ready) {
        refresh()
      }
      ready = true
    } else if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
      refresh()
    } else if (event.type === 'end' || event.type === 'error') {
      ready = false
    }
  })
}

export type MergedDesktopCatalogs = {
  catalogs: DesktopWorkspaceCatalog[]
  /** True until the first fetch settles and nothing was recoverable from cache. */
  loading: boolean
  /** True only after every persistent and on-demand desktop attempt settles. */
  rosterSettled: boolean
  refresh: () => Promise<void>
}

export function useMergedDesktopCatalogs(
  desktops: readonly DesktopClient[]
): MergedDesktopCatalogs {
  const [catalogsByHostId, setCatalogsByHostId] = useState<CatalogsByHostId>({})
  const [settled, setSettled] = useState(false)
  const desktopsRef = useRef<readonly DesktopClient[]>(desktops)
  const mountedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const acceptedRequestSequenceRef = useRef<Record<string, number>>({})
  const transientAbortRef = useRef<AbortController | null>(null)
  const transientClientsRef = useRef<Map<string, { client: RpcClient; requestSequence: number }>>(
    new Map()
  )

  const rosterKey = JSON.stringify(
    desktops
      .map((desktop) => [desktop.hostId, desktop.hostName, profileIdentity(desktop.profile)])
      .sort()
  )
  const connectedKey = JSON.stringify(
    desktops
      .filter(
        (desktop): desktop is DesktopClient & { client: RpcClient } =>
          desktop.state === 'connected' &&
          desktop.client !== null &&
          transientClientsRef.current.get(desktop.hostId)?.client !== desktop.client
      )
      .map((desktop) => [desktop.hostId, clientIdentity(desktop.client)])
      .sort()
  )
  const refresh = useCallback(async () => {
    transientAbortRef.current?.abort()
    const transientAbort = new AbortController()
    transientAbortRef.current = transientAbort
    setSettled(false)
    const requestSequence = ++requestSequenceRef.current
    const targets = desktopsRef.current
    const connected = targets.filter(
      (desktop): desktop is DesktopClient & { client: RpcClient } =>
        desktop.state === 'connected' && desktop.client !== null
    )
    const applyResults = (
      results: {
        desktop: DesktopClient
        client: RpcClient
        catalog: DesktopWorkspaceCatalog | null
      }[]
    ) => {
      if (!mountedRef.current) {
        return
      }
      const currentByHostId = new Map(
        desktopsRef.current.map((desktop) => [desktop.hostId, desktop])
      )
      const accepted = results.filter(({ desktop, client, catalog }) => {
        const current = currentByHostId.get(desktop.hostId)
        if (
          !catalog ||
          !current ||
          current.profile !== desktop.profile ||
          (current.client !== null && current.client !== client) ||
          requestSequence <= (acceptedRequestSequenceRef.current[desktop.hostId] ?? 0)
        ) {
          return false
        }
        acceptedRequestSequenceRef.current[desktop.hostId] = requestSequence
        setCachedWorktrees(desktop.hostId, [...catalog.worktrees], { proven: true })
        setCachedRepos(desktop.hostId, [...(catalog.repos ?? [])])
        return true
      })
      setCatalogsByHostId((prev) => {
        const next: CatalogsByHostId = {}
        const resultsByHostId = new Map(accepted.map((result) => [result.desktop.hostId, result]))
        for (const desktop of desktopsRef.current) {
          const result = resultsByHostId.get(desktop.hostId)
          const resolved =
            result?.catalog ??
            prev[desktop.hostId] ??
            cachedCatalog(desktop.hostId, desktop.hostName)
          if (resolved) {
            next[desktop.hostId] = { ...resolved, desktopHostName: desktop.hostName }
          }
        }
        return next
      })
    }
    const connectedResults = await Promise.all(
      connected.map((desktop) =>
        fetchCatalog(desktop, desktop.client)
          .catch(() => null)
          .then((catalog) => ({ desktop, client: desktop.client, catalog }))
      )
    )
    applyResults(connectedResults)
    if (!mountedRef.current || transientAbort.signal.aborted) {
      return
    }
    for (const desktop of targets) {
      if (desktop.client || !desktop.profile || !desktop.acquireClient) {
        continue
      }
      const lease = await desktop.acquireClient(
        desktop.profile,
        transientAbort.signal,
        (client) => {
          transientClientsRef.current.set(desktop.hostId, { client, requestSequence })
        }
      )
      if (!lease) {
        const ownership = transientClientsRef.current.get(desktop.hostId)
        if (ownership?.requestSequence === requestSequence) {
          transientClientsRef.current.delete(desktop.hostId)
        }
        continue
      }
      try {
        if (!mountedRef.current || transientAbort.signal.aborted) {
          return
        }
        const catalog = await fetchCatalog(desktop, lease.client).catch(() => null)
        if (!mountedRef.current || transientAbort.signal.aborted) {
          return
        }
        applyResults([{ desktop, client: lease.client, catalog }])
      } finally {
        lease.release()
        const ownership = transientClientsRef.current.get(desktop.hostId)
        if (ownership?.requestSequence === requestSequence && ownership.client === lease.client) {
          transientClientsRef.current.delete(desktop.hostId)
        }
      }
      if (!mountedRef.current || transientAbort.signal.aborted) {
        return
      }
    }
    setSettled(true)
  }, [])

  useEffect(() => {
    desktopsRef.current = desktops
  }, [desktops])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      transientAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [connectedKey, refresh, rosterKey])

  useEffect(() => {
    const cleanups = desktopsRef.current
      .filter((desktop) => desktop.state === 'connected')
      .filter(
        (desktop): desktop is DesktopClient & { client: RpcClient } => desktop.client !== null
      )
      .map((desktop) => subscribeToCatalogChanges(desktop, () => void refresh()))
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [connectedKey, refresh])

  const catalogs = useMemo(
    () =>
      desktops.flatMap((desktop) => {
        const catalog =
          catalogsByHostId[desktop.hostId] ?? cachedCatalog(desktop.hostId, desktop.hostName)
        return catalog ? [{ ...catalog, desktopHostName: desktop.hostName }] : []
      }),
    [desktops, catalogsByHostId]
  )

  return { catalogs, loading: !settled && catalogs.length === 0, rosterSettled: settled, refresh }
}
