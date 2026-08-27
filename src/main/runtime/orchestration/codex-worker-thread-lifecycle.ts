import { resolveCodexCommand } from '../../codex-cli/command'
import {
  applyCodexWorkerThreadName,
  archiveCodexWorkerThread,
  buildCodexWorkerThreadName,
  type CodexWorkerThreadRequest
} from '../../codex/codex-worker-thread-lifecycle'
import { getSystemCodexHomePath } from '../../codex/codex-home-paths'
import { runCodexAppServerSession } from '../../codex/codex-app-server-session'
import { getSpawnArgsForWindows } from '../../win32-utils'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import type { OrchestrationDb } from './db'

export type WithCodexWorkerThreadAppServer = <T>(
  body: (request: CodexWorkerThreadRequest) => Promise<T>
) => Promise<T>

type ReconcileDispatchArgs = {
  db: OrchestrationDb
  dispatchId: string
  getExactWorkerProviderSession: (
    terminalHandle: string,
    observedAfter: number
  ) => ExactWorkerProviderSession | null
  withCodex?: WithCodexWorkerThreadAppServer
}

export async function reconcileCodexWorkerThreadForDispatch(args: ReconcileDispatchArgs): Promise<{
  state: 'session_pending' | 'not_codex' | 'named' | 'already_named' | 'user_named'
}> {
  let resource = args.db.getWorkerTerminalResourceByOwner(args.dispatchId)
  if (!resource || resource.ownership_state !== 'owned') {
    return { state: 'session_pending' }
  }
  if (!resource.codex_thread_id) {
    const worker = args.db.getWorkerDispatch(args.dispatchId)
    const observedAfter = worker ? parseSqliteTimestamp(worker.created_at) : 0
    const exact = args.getExactWorkerProviderSession(resource.terminal_handle, observedAfter)
    if (!exact) {
      return { state: 'session_pending' }
    }
    if (exact.agent !== 'codex' || exact.providerSession.key !== 'session_id') {
      return { state: 'not_codex' }
    }
    const dispatch = args.db.getDispatchContextById(args.dispatchId)
    const task = dispatch ? args.db.getTask(dispatch.task_id) : undefined
    if (!task) {
      throw new Error(`Cannot name Codex worker ${args.dispatchId}: task identity is missing.`)
    }
    resource = args.db.recordWorkerCodexThreadIdentity({
      dispatchId: args.dispatchId,
      resourceId: resource.id,
      threadId: exact.providerSession.id,
      autoName: buildCodexWorkerThreadName({
        spec: task.spec,
        taskTitle: task.task_title,
        displayName: task.display_name
      })
    })
  }
  if (resource.codex_name_state !== 'pending') {
    return {
      state: resource.codex_name_state === 'user_named' ? 'user_named' : 'already_named'
    }
  }
  try {
    const result = await (args.withCodex ?? withSystemCodexWorkerThreadAppServer)((request) =>
      applyCodexWorkerThreadName({
        threadId: resource.codex_thread_id as string,
        desiredName: resource.codex_auto_name as string,
        request
      })
    )
    args.db.markWorkerCodexThreadNameOutcome(
      resource.id,
      result.state === 'user_named' ? 'user_named' : 'applied'
    )
    return { state: result.state }
  } catch (error) {
    args.db.recordWorkerCodexThreadLifecycleError(resource.id, errorMessage(error))
    throw error
  }
}

export async function archiveReleasedCodexWorkerThread(args: {
  db: OrchestrationDb
  dispatchId: string
  resourceId: string
  withCodex?: WithCodexWorkerThreadAppServer
}): Promise<{ state: 'archived' | 'already_archived' | 'not_applicable' }> {
  const resource = args.db.getWorkerTerminalResource(args.resourceId)
  if (
    !resource ||
    resource.owner_dispatch_id !== args.dispatchId ||
    resource.ownership_state !== 'released' ||
    resource.release_state !== 'released' ||
    !resource.codex_thread_id
  ) {
    return { state: 'not_applicable' }
  }
  if (resource.codex_archive_state === 'archived') {
    return { state: 'already_archived' }
  }
  if (resource.codex_archive_state !== 'requested') {
    return { state: 'not_applicable' }
  }
  try {
    const result = await (args.withCodex ?? withSystemCodexWorkerThreadAppServer)((request) =>
      archiveCodexWorkerThread({ threadId: resource.codex_thread_id as string, request })
    )
    args.db.markWorkerCodexThreadArchived(resource.id)
    return result
  } catch (error) {
    args.db.recordWorkerCodexThreadLifecycleError(resource.id, errorMessage(error))
    throw error
  }
}

export async function retryCodexWorkerThreadLifecycleBacklog(args: {
  db: OrchestrationDb
  withCodex?: WithCodexWorkerThreadAppServer
}): Promise<{ attempted: number; completed: number; failed: number }> {
  const backlog = args.db.listWorkerCodexThreadLifecycleBacklog()
  let completed = 0
  let failed = 0
  for (const resource of backlog) {
    try {
      if (resource.codex_name_state === 'pending') {
        const result = await (args.withCodex ?? withSystemCodexWorkerThreadAppServer)((request) =>
          applyCodexWorkerThreadName({
            threadId: resource.codex_thread_id as string,
            desiredName: resource.codex_auto_name as string,
            request
          })
        )
        args.db.markWorkerCodexThreadNameOutcome(
          resource.id,
          result.state === 'user_named' ? 'user_named' : 'applied'
        )
      }
      if (resource.codex_archive_state === 'requested') {
        await archiveReleasedCodexWorkerThread({
          db: args.db,
          dispatchId: resource.owner_dispatch_id,
          resourceId: resource.id,
          ...(args.withCodex ? { withCodex: args.withCodex } : {})
        })
      }
      completed += 1
    } catch (error) {
      args.db.recordWorkerCodexThreadLifecycleError(resource.id, errorMessage(error))
      failed += 1
    }
  }
  return { attempted: backlog.length, completed, failed }
}

export async function withSystemCodexWorkerThreadAppServer<T>(
  body: (request: CodexWorkerThreadRequest) => Promise<T>
): Promise<T> {
  const command = resolveCodexCommand()
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, ['app-server'])
  return runCodexAppServerSession(
    {
      command: spawnCmd,
      args: spawnArgs,
      env: { CODEX_HOME: getSystemCodexHomePath() },
      timeoutMs: 20_000
    },
    ({ request }) => body(request)
  )
}

function parseSqliteTimestamp(value: string): number {
  const timestamp = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
