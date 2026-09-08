import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { parseSearchCommand } from '../search-command-arguments'
import {
  formatAgentSessionSearch,
  formatAgentSessionSearchStatus,
  terminalSafe
} from '../agent-session-search-format'
import {
  ReceivedSessionSearchResultSchema,
  SessionSearchStatusSchema,
  type SessionSearchOperation
} from '../../shared/ai-vault-search-contract'
import { listSshTargets, findSshTargetByName } from '../host-selector-alternatives'
import { searchAllHosts } from '../session-search-all-hosts'
import {
  createSearchHostCall,
  SEARCH_ALL_TIMEOUT_MS,
  type SearchHost
} from '../session-search-host-query'

export const SEARCH_DISABLED_MESSAGE =
  'Session search is off. Enable it in Settings > Agent Session History, or run `orca search --agent-session --enable`.'

export const SEARCH_HANDLERS: Record<string, CommandHandler> = {
  search: async ({ client, flags, json, cwd }) => {
    const command = parseSearchCommand(flags, client.isRemote)
    const controller = new AbortController()
    const deadline = Date.now() + SEARCH_ALL_TIMEOUT_MS
    const timer = setTimeout(
      () => controller.abort(new Error('Search deadline exceeded.')),
      SEARCH_ALL_TIMEOUT_MS
    )
    let interrupted = false
    const interrupt = (): void => {
      interrupted = true
      process.exitCode = 130
      controller.abort(new Error('Search interrupted.'))
    }
    process.once('SIGINT', interrupt)
    try {
      if (command.host === 'all') {
        const result = await searchAllHosts(client, command, controller.signal, deadline)
        printResult(
          { id: 'search-all', ok: true, result, _meta: { runtimeId: 'client' } },
          json,
          (value) =>
            value.hosts
              .map((entry) =>
                [
                  `${terminalSafe(entry.host.name)} (${terminalSafe(entry.host.selector || 'current runtime')}) — ${entry.outcome}`,
                  entry.result
                    ? formatAgentSessionSearch(entry.result, {
                        query: command.query!.query,
                        cwd,
                        owner: entry.host.name
                      })
                    : terminalSafe(entry.message ?? '')
                ].join('\n')
              )
              .join('\n\n') +
            (value.omittedHosts ? `\n${value.omittedHosts} additional hosts omitted.` : '')
        )
        if (!result.hosts.some((host) => host.outcome === 'searched') && process.exitCode !== 130) {
          process.exitCode = 1
        }
        return
      }
      const host: SearchHost = {
        id: command.host?.id ?? 'local',
        name: command.host?.id ?? (client.isRemote ? 'selected runtime' : 'this runtime'),
        selector: '',
        client
      }
      if (command.host?.kind === 'ssh') {
        const targets = await listSshTargets(client, {
          strict: true,
          signal: controller.signal,
          deadline
        })
        const target = findSshTargetByName(targets, command.host.targetId)
        if (!target) {
          throw new RuntimeClientError('invalid_argument', 'Unknown or ambiguous SSH target.')
        }
        if (target.connected !== true) {
          throw new RuntimeClientError(
            'runtime_unavailable',
            'SSH target is not known to be connected.'
          )
        }
        host.targetId = target.id
        host.name = target.label
      }
      // Why: `--host runtime:<env>` already selected that runtime's transport, so
      // the id only restamps the answer; the targetId spread lives in the shared
      // call factory with the method routing and the deadline.
      const stamp =
        !host.targetId && command.host?.kind === 'runtime'
          ? { executionHostId: command.host.id }
          : {}
      const send = createSearchHostCall(host, controller.signal, deadline)
      const call = (operation: SessionSearchOperation, params: object) =>
        send(operation, { ...params, ...stamp })
      if (command.configure || command.status) {
        const response = await call(
          command.configure ? 'configure' : 'status',
          command.configure ?? {}
        )
        const status = SessionSearchStatusSchema.parse(response.result)
        // Why `available` only: a host that could not apply the change throws, so
        // `applied: false` on a returned status is a concurrent apply still in
        // flight, not this configure failing.
        if (command.configure && status.available === false) {
          throw new RuntimeClientError(
            'failed_precondition',
            status.reason ?? 'Search policy is unavailable.'
          )
        }
        if (!command.query) {
          printResult({ ...response, result: status }, json, formatAgentSessionSearchStatus)
          return
        }
      }
      const response = await call('query', command.query!)
      const result = ReceivedSessionSearchResultSchema.parse(response.result)
      if (result.coverage.enabled === false) {
        throw new RuntimeClientError('failed_precondition', SEARCH_DISABLED_MESSAGE, {
          disabled: true
        })
      }
      printResult({ ...response, result }, json, (value) =>
        formatAgentSessionSearch(value, {
          query: command.query!.query,
          cwd,
          ...(host.targetId || client.isRemote || host.id.startsWith('runtime:')
            ? { owner: host.name }
            : {})
        })
      )
    } catch (error) {
      if (!interrupted) {
        throw error
      }
    } finally {
      clearTimeout(timer)
      process.removeListener('SIGINT', interrupt)
    }
  }
}

export type { AiVaultSearchHit } from '../../shared/ai-vault-search-types'
