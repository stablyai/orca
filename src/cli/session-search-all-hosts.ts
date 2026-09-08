import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { toSshExecutionHostId, toRuntimeExecutionHostId } from '../shared/execution-host'
import { waitForPromiseWithSignal } from '../shared/abort-signal-reason'
import { getDefaultUserDataPath, RuntimeClient } from './runtime-client'
import { listEnvironments } from './runtime/environments'
import { listSshTargets } from './host-selector-alternatives'
import { quoteCliCommandArgument } from './shell-command-quote'
import type { SearchCommand } from './search-command-arguments'
import {
  querySearchHost,
  SEARCH_ALL_HOST_LIMIT,
  SEARCH_HOST_TIMEOUT_MS,
  type SearchHost,
  type SearchHostResult
} from './session-search-host-query'

export type AllHostSearchResult = {
  hosts: SearchHostResult[]
  partial: boolean
  omittedHosts: number
}

export async function searchAllHosts(
  client: RuntimeClient,
  command: SearchCommand,
  signal: AbortSignal,
  deadline: number,
  dependencies: {
    listEnvironments: (path: string) => { id: string; name: string }[]
    listSshTargets: typeof listSshTargets
    createClient: (id: string) => RuntimeClient
  } = {
    listEnvironments,
    listSshTargets,
    createClient: (id: string) => new RuntimeClient(undefined, undefined, null, id)
  }
): Promise<AllHostSearchResult> {
  const hosts: SearchHost[] = [
    {
      id: 'local',
      name: client.isRemote ? 'Selected runtime' : 'This runtime',
      selector: '',
      client
    }
  ]
  const skipped: SearchHostResult[] = []
  const runtimeContext = client.isRemote
    ? client.selectedEnvironment
      ? `--environment ${quoteCliCommandArgument(client.selectedEnvironment)}`
      : 'in the same paired-runtime context'
    : ''
  let omittedHosts = 0
  if (!client.isRemote) {
    try {
      const environments = dependencies.listEnvironments(getDefaultUserDataPath())
      for (const environment of environments.slice(0, SEARCH_ALL_HOST_LIMIT - 1)) {
        const host = {
          id: toRuntimeExecutionHostId(environment.id),
          name: environment.name,
          selector: `--host ${toRuntimeExecutionHostId(environment.id)}`
        }
        try {
          hosts.push({ ...host, client: dependencies.createClient(environment.id) })
        } catch {
          skipped.push({
            host,
            outcome: 'unavailable',
            message: 'Could not resolve the saved pairing.'
          })
        }
      }
      omittedHosts += Math.max(0, environments.length - SEARCH_ALL_HOST_LIMIT + 1)
    } catch {
      skipped.push({
        host: { id: 'pairing-inventory', name: 'Paired servers', selector: '' },
        outcome: 'failed',
        message: 'Could not read the pairing inventory.'
      })
    }
  }
  const inventoryController = new AbortController()
  const abortInventory = (): void => inventoryController.abort(signal.reason)
  signal.addEventListener('abort', abortInventory, { once: true })
  if (signal.aborted) {
    abortInventory()
  }
  const inventoryDeadline = Math.min(deadline, Date.now() + 3_000)
  const inventoryTimer = setTimeout(
    () => inventoryController.abort(new Error('SSH inventory deadline exceeded.')),
    Math.max(1, inventoryDeadline - Date.now())
  )
  try {
    const targets = await waitForPromiseWithSignal(
      dependencies.listSshTargets(client, {
        strict: true,
        signal: inventoryController.signal,
        deadline: inventoryDeadline
      }),
      inventoryController.signal
    )
    for (const target of targets.slice(0, SEARCH_ALL_HOST_LIMIT)) {
      const host = {
        id: toSshExecutionHostId(target.id),
        name: target.label,
        selector: `${runtimeContext ? `${runtimeContext} ` : ''}--host ${toSshExecutionHostId(target.id)}`
      }
      if (target.connected === true && hosts.length < SEARCH_ALL_HOST_LIMIT) {
        hosts.push({ ...host, client, targetId: target.id })
      } else {
        skipped.push({
          host,
          outcome: target.connected === true ? 'omitted' : 'unavailable',
          message:
            target.connected === true
              ? 'Host limit reached.'
              : 'SSH target is not known to be connected.'
        })
      }
    }
    omittedHosts += Math.max(0, targets.length - SEARCH_ALL_HOST_LIMIT)
  } catch {
    skipped.push({
      host: { id: 'ssh-inventory', name: 'SSH targets', selector: '' },
      outcome: 'failed',
      message: 'Could not read SSH inventory.'
    })
  } finally {
    clearTimeout(inventoryTimer)
    signal.removeEventListener('abort', abortInventory)
  }
  let bytesRemaining = 4 * 1024 * 1024 - 128 * 1024
  const results = await mapWithConcurrency(hosts, 3, async (host): Promise<SearchHostResult> => {
    if (signal.aborted || Date.now() >= deadline) {
      return {
        host: { id: host.id, name: host.name, selector: host.selector },
        outcome: 'omitted',
        message: 'Overall search deadline exceeded.'
      }
    }
    // Why: querySearchHost owns the per-host deadline; arming a second one here
    // produced two timers and two error messages for one call.
    const result = await querySearchHost(
      host,
      command,
      true,
      signal,
      Math.min(deadline, Date.now() + SEARCH_HOST_TIMEOUT_MS)
    )
    const bytes = Buffer.byteLength(JSON.stringify(result))
    if (bytes > bytesRemaining) {
      return {
        host: result.host,
        outcome: 'omitted',
        message: 'Aggregate response limit reached.'
      }
    }
    bytesRemaining -= bytes
    return result
  })
  const combined = [...results, ...skipped]
  if (
    Buffer.byteLength(JSON.stringify({ hosts: combined, partial: true, omittedHosts })) >
    4 * 1024 * 1024
  ) {
    return {
      hosts: [
        {
          host: { id: 'inventory', name: 'Host inventory', selector: '' },
          outcome: 'failed',
          message: 'Host metadata exceeds the aggregate response limit.'
        }
      ],
      partial: true,
      omittedHosts: omittedHosts + combined.length
    }
  }
  return {
    hosts: combined,
    partial:
      omittedHosts > 0 ||
      combined.some(
        (host) =>
          host.outcome !== 'searched' ||
          host.result?.omittedHits ||
          // Not `sourceUnavailableFiles`: an unverifiable source keeps its hit in
          // this answer, so nothing is missing from the aggregate. The per-host
          // count rides the result and is reported next to that host's hits.
          host.result?.coverage.providers.some(
            (provider) =>
              (provider.parseFailures ?? 0) > 0 ||
              (provider.scanIssues ?? 0) > 0 ||
              ((provider.filesDiscovered ?? 0) > 0 && provider.sessionsIndexed === 0)
          ) ||
          host.result?.coverage.backfill !== 'complete' ||
          host.result?.coverage.filesPending
      ),
    omittedHosts
  }
}
