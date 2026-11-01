import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { resolveCoordinatorTerminalHandle, runScopedSessionCaller } from './terminal-identity'

async function resolveOptionalPeerCallerHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string | undefined> {
  const explicitFrom = getOptionalStringFlag(flags, 'from')
  if (explicitFrom) {
    return explicitFrom
  }
  const sessionCaller = runScopedSessionCaller(flags)
  if (sessionCaller) {
    return sessionCaller
  }
  try {
    return await resolveCoordinatorTerminalHandle(flags, cwd, client)
  } catch {
    return process.env.ORCA_TERMINAL_HANDLE?.trim() || undefined
  }
}

export const ORCHESTRATION_LOCK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration lock-acquire': async ({ flags, client, cwd, json }) => {
    const from = await resolveOptionalPeerCallerHandle(flags, cwd, client)
    const result = await client.call<{
      lock: {
        id: string
        resource_key: string
        owner_handle: string
        status: string
        reason: string
      }
      position: number
      holder: { owner_handle: string; reason: string }
      waitedMs: number
      timedOut?: boolean
    }>('orchestration.lockAcquire', {
      resource: getRequiredStringFlag(flags, 'resource'),
      reason: getOptionalStringFlag(flags, 'reason'),
      ttlMs: getOptionalPositiveIntegerFlag(flags, 'ttl-ms'),
      wait: flags.get('wait') === true ? true : undefined,
      timeoutMs: getOptionalPositiveIntegerFlag(flags, 'timeout-ms'),
      from
    })
    printResult(result, json, (value) => {
      if (value.position === 0) {
        return `Lock ${value.lock.resource_key} acquired by ${value.lock.owner_handle} [${value.lock.status}]`
      }
      return `Lock ${value.lock.resource_key} queued at position ${value.position} (held by ${value.holder.owner_handle})`
    })
  },

  'orchestration lock-release': async ({ flags, client, cwd, json }) => {
    const from = await resolveOptionalPeerCallerHandle(flags, cwd, client)
    const resource = getRequiredStringFlag(flags, 'resource')
    const result = await client.call<{
      released: boolean
      promoted: { owner_handle: string } | null
    }>('orchestration.lockRelease', {
      resource,
      force: flags.get('force') === true ? true : undefined,
      from
    })
    printResult(result, json, (value) => {
      if (!value.released) {
        return `No active lock held for ${resource}.`
      }
      return value.promoted
        ? `Lock ${resource} released; promoted ${value.promoted.owner_handle}.`
        : `Lock ${resource} released.`
    })
  },

  'orchestration lock-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      locks: {
        id: string
        resource_key: string
        owner_handle: string
        status: string
        position: number
        reason: string
      }[]
      count: number
    }>('orchestration.lockList', {
      resource: getOptionalStringFlag(flags, 'resource')
    })
    printResult(result, json, (value) => {
      if (value.locks.length === 0) {
        return 'No active resource locks.'
      }
      return value.locks
        .map(
          (lock) =>
            `${lock.resource_key} [${lock.status}#${lock.position}] owner=${lock.owner_handle}${
              lock.reason ? ` "${lock.reason}"` : ''
            }`
        )
        .join('\n')
    })
  },

  'orchestration board-post': async ({ flags, client, cwd, json }) => {
    const from = await resolveOptionalPeerCallerHandle(flags, cwd, client)
    const result = await client.call<{
      entry: {
        id: string
        scope_key: string
        kind: string
        title: string
        status: string
        author_handle: string
        assignee_handle: string | null
      }
    }>('orchestration.boardPost', {
      title: getRequiredStringFlag(flags, 'title'),
      body: getOptionalStringFlag(flags, 'body'),
      kind: getOptionalStringFlag(flags, 'kind'),
      scope: getOptionalStringFlag(flags, 'scope'),
      assignee: getOptionalStringFlag(flags, 'assignee'),
      from
    })
    printResult(
      result,
      json,
      (value) =>
        `Board ${value.entry.kind} ${value.entry.id} posted [${value.entry.status}]: ${value.entry.title}`
    )
  },

  'orchestration board-claim': async ({ flags, client, cwd, json }) => {
    const from = await resolveOptionalPeerCallerHandle(flags, cwd, client)
    const result = await client.call<{
      entry: {
        id: string
        title: string
        status: string
        assignee_handle: string | null
      }
    }>('orchestration.boardClaim', {
      id: getRequiredStringFlag(flags, 'id'),
      status: getOptionalStringFlag(flags, 'status'),
      from
    })
    printResult(
      result,
      json,
      (value) =>
        `Board entry ${value.entry.id} [${value.entry.status}] assignee=${value.entry.assignee_handle ?? 'none'}`
    )
  },

  'orchestration board-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      entries: {
        id: string
        scope_key: string
        kind: string
        title: string
        status: string
        author_handle: string
        assignee_handle: string | null
      }[]
      count: number
    }>('orchestration.boardList', {
      scope: getOptionalStringFlag(flags, 'scope'),
      kind: getOptionalStringFlag(flags, 'kind'),
      status: getOptionalStringFlag(flags, 'status'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, (value) => {
      if (value.entries.length === 0) {
        return 'No collaboration board entries.'
      }
      return value.entries
        .map(
          (entry) =>
            `${entry.id} [${entry.kind}/${entry.status}] scope=${entry.scope_key} author=${entry.author_handle}${
              entry.assignee_handle ? ` assignee=${entry.assignee_handle}` : ''
            } "${entry.title}"`
        )
        .join('\n')
    })
  }
}
