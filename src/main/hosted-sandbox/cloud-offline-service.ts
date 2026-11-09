// Offline reading and wake on message for Orca Cloud workspaces:
// - a read-through cache at the window's runtime call seam (allowlisted read-only methods), served
//   when the VM is asleep instead of the asleep refusal;
// - a snapshot read right before Sleep, while terminals and chats are still up;
// - the queued-prompt store that wakes the VM and delivers once orcad is ready.
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { isEphemeralVmSuspended } from '../../shared/ephemeral-vm-environment-sleep'
import {
  ORCA_CLOUD_OFFLINE_CHANNELS as CH,
  type CloudOfflineSnapshot
} from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import {
  RECIPE_VM_OPEN_HOLD_MS,
  RECIPE_VM_REFUSAL_CODES
} from '../../shared/remote-runtime/recipe-vm-wake'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse,
  RuntimeRpcSuccess
} from '../../shared/runtime-rpc-envelope'
import { getRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { createCloudMessageQueue, type CloudMessageQueue } from './cloud-message-queue'
import {
  createCloudOfflineCache,
  OFFLINE_READ_METHODS,
  type CloudOfflineCache
} from './cloud-offline-cache'
import { archiveCheckoutsFromCache, buildOfflineSnapshot } from './cloud-offline-snapshot'
import { getHostedWorkspaceService, setArchiveCheckoutsProvider } from './hosted-workspace-service'

type CloudRuntimeInfo = {
  workspaceId: string
  environmentId: string
  asleep: boolean
  projectRoot: string | null
}

/** Codes a call to a sleeping (or not yet woken) VM gets: the moment to answer from the cache. */
const OFFLINE_FALLBACK_CODES: ReadonlySet<string> = new Set([
  ...RECIPE_VM_REFUSAL_CODES,
  'runtime_unreachable',
  'runtime_unresponsive',
  'runtime_environment_unreachable'
])

const CAPTURE_BUDGET_MS = 8_000
const MAX_CAPTURED_TERMINALS = 12

export type CloudOfflineSeam = {
  /** After a window call answered: keep allowlisted answers from Orca Cloud environments. */
  observe(
    environmentId: string,
    method: string,
    params: unknown,
    response: RuntimeRpcResponse<unknown>
  ): void
  /** A call was refused (asleep, waking, unreachable): the cached answer, marked offline, or null. */
  fallback(
    environmentId: string,
    method: string,
    params: unknown,
    failure: RuntimeRpcFailure
  ): RuntimeRpcSuccess<unknown> | null
}

let seam: CloudOfflineSeam | null = null
export function getCloudOfflineSeam(): CloudOfflineSeam | null {
  return seam
}

/** The window's call seam: record an answer, or replace a sleeping-VM refusal with the cached one. */
export function withCloudOfflineAnswer(
  environmentId: string,
  method: string,
  params: unknown,
  response: RuntimeRpcResponse<unknown>
): RuntimeRpcResponse<unknown> {
  if (!seam) {
    return response
  }
  if (response.ok) {
    seam.observe(environmentId, method, params, response)
    return response
  }
  return seam.fallback(environmentId, method, params, response) ?? response
}

export type CloudOfflineService = {
  seam: CloudOfflineSeam
  cache: CloudOfflineCache
  queue: CloudMessageQueue
  /** Read the workspace's terminals, git state and known chats into the cache (before Sleep). */
  capture(workspaceId: string): Promise<void>
  dispose(): void
}

type Call = (
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

export function installCloudOfflineService(deps: {
  userDataPath: string
  call: Call
  windows: () => readonly BrowserWindow[]
  log?: (line: string) => void
}): CloudOfflineService {
  const log = deps.log ?? ((line: string) => console.error(line))
  const cache = createCloudOfflineCache({ root: join(deps.userDataPath, 'orca-cloud-offline') })
  let memo: {
    at: number
    byEnvironment: Map<string, CloudRuntimeInfo>
    byWorkspace: Map<string, CloudRuntimeInfo>
  } | null = null

  // The runtime store is a file read; the seam runs on hot read paths, so it is memoized briefly.
  function runtimes(): NonNullable<typeof memo> {
    if (memo && Date.now() - memo.at < 3_000) {
      return memo
    }
    const byEnvironment = new Map<string, CloudRuntimeInfo>()
    const byWorkspace = new Map<string, CloudRuntimeInfo>()
    for (const runtime of listEphemeralVmRuntimes(deps.userDataPath)) {
      if (
        runtime.recipe?.provider !== 'orca-cloud' ||
        !runtime.runtimeEnvironmentId ||
        !runtime.workspaceId
      ) {
        continue
      }
      let projectRoot: string | null = null
      if (runtime.recipeResult) {
        const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
        projectRoot = connection.type === 'orca-server' ? (connection.projectRoot ?? null) : null
      }
      const info = {
        workspaceId: runtime.workspaceId,
        environmentId: runtime.runtimeEnvironmentId,
        asleep: isEphemeralVmSuspended(runtime),
        projectRoot
      }
      byEnvironment.set(info.environmentId, info)
      byWorkspace.set(info.workspaceId, info)
    }
    memo = { at: Date.now(), byEnvironment, byWorkspace }
    return memo
  }
  const invalidate = () => {
    memo = null
  }

  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of deps.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  const service: CloudOfflineSeam = {
    observe(environmentId, method, params, response) {
      if (
        !response.ok ||
        !OFFLINE_READ_METHODS.has(method) ||
        !runtimes().byEnvironment.has(environmentId)
      ) {
        return
      }
      cache.record(environmentId, method, params, response)
    },
    fallback(environmentId, method, params, failure) {
      if (!OFFLINE_READ_METHODS.has(method) || !OFFLINE_FALLBACK_CODES.has(failure.error.code)) {
        return null
      }
      if (!runtimes().byEnvironment.has(environmentId)) {
        return null
      }
      const hit = cache.lookup(environmentId, method, params)
      if (!hit) {
        return null
      }
      return {
        id: failure.id,
        ok: true,
        result: hit.result,
        _meta: { runtimeId: hit.runtimeId, offlineCachedAt: hit.at }
      }
    }
  }

  async function readInto(
    environmentId: string,
    method: string,
    params: unknown,
    deadline: number
  ): Promise<unknown> {
    const remaining = deadline - Date.now()
    if (remaining <= 250) {
      return null
    }
    try {
      const response = await deps.call(environmentId, method, params, Math.min(remaining, 5_000))
      if (response.ok) {
        cache.record(environmentId, method, params, response)
        return response.result
      }
    } catch {
      // Best effort: Sleep must not wait on a slow read.
    }
    return null
  }

  async function capture(workspaceId: string): Promise<void> {
    const info = runtimes().byWorkspace.get(workspaceId)
    if (!info || info.asleep) {
      return
    }
    const deadline = Date.now() + CAPTURE_BUDGET_MS
    const worktree = `id:${workspaceId}`
    const env = info.environmentId
    // Chats the window has read stay current: refresh their tail pages.
    const sessions = [
      ...new Set(
        cache
          .entries(env, 'agentSession.history')
          .map((entry) => (entry.params as { sessionId?: string } | null)?.sessionId)
          .filter((id): id is string => typeof id === 'string')
      )
    ].slice(0, 20)
    const [list] = await Promise.all([
      readInto(env, 'terminal.list', { worktree }, deadline),
      readInto(env, 'git.status', { worktree }, deadline),
      readInto(env, 'git.history', { worktree, limit: 20 }, deadline),
      ...sessions.map((sessionId) =>
        readInto(
          env,
          'agentSession.history',
          { sessionId, direction: 'tail', limit: 200 },
          deadline
        )
      )
    ])
    const terminals = (
      (list as { terminals?: { handle: string }[] } | null)?.terminals ?? []
    ).slice(0, MAX_CAPTURED_TERMINALS)
    await Promise.all(
      terminals.map((terminal) =>
        readInto(env, 'terminal.read', { terminal: terminal.handle, limit: 400 }, deadline)
      )
    )
    cache.flush()
  }

  const queue = createCloudMessageQueue({
    path: join(deps.userDataPath, 'orca-cloud-queued-prompts.json'),
    locate: (workspaceId) => {
      invalidate()
      const info = runtimes().byWorkspace.get(workspaceId)
      return info ? { environmentId: info.environmentId, asleep: info.asleep } : null
    },
    wake: async (workspaceId) => {
      const waker = getRecipeVmWaker()
      if (!waker) {
        return false
      }
      getHostedWorkspaceService()?.noteWakeSource(workspaceId, 'message')
      const opening = await waker.holdOpen(workspaceId, true, RECIPE_VM_OPEN_HOLD_MS)
      invalidate()
      return opening === 'up'
    },
    call: deps.call,
    onChange: (workspaceId) => broadcast(CH.queuedPromptsChanged, { workspaceId }),
    log
  })

  setArchiveCheckoutsProvider(async (workspaceId) => {
    const info = runtimes().byWorkspace.get(workspaceId)
    return info
      ? archiveCheckoutsFromCache(
          cache,
          info.environmentId,
          info.projectRoot ?? '/vercel/sandbox/project'
        )
      : null
  })

  for (const channel of Object.values(CH)) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(
    CH.getSnapshot,
    (_event, args: { workspaceId: string }): CloudOfflineSnapshot | null => {
      invalidate()
      const info = runtimes().byWorkspace.get(args.workspaceId)
      return info
        ? buildOfflineSnapshot(cache, info.environmentId, args.workspaceId, info.asleep)
        : null
    }
  )
  ipcMain.handle(
    CH.queuePrompt,
    (_event, args: { workspaceId: string; sessionId: string; text: string }) => {
      if (!runtimes().byWorkspace.has(args.workspaceId)) {
        return { ok: false, message: 'Not an Orca Cloud workspace.' }
      }
      try {
        const prompt = queue.enqueue(args)
        void queue.drive(args.workspaceId)
        return { ok: true, prompt }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  ipcMain.handle(CH.listQueuedPrompts, (_event, args: { workspaceId: string }) =>
    queue.list(args.workspaceId)
  )
  ipcMain.handle(CH.cancelQueuedPrompt, (_event, args: { id: string }) => queue.cancel(args.id))
  ipcMain.handle(CH.editQueuedPrompt, (_event, args: { id: string; text: string }) =>
    queue.edit(args.id, args.text)
  )

  // Re-drive pending prompts after a restart, and keep retrying unconfirmed ones on a slow beat.
  const beat = setInterval(() => {
    invalidate()
    void queue.drive()
    cache.prune(new Set(runtimes().byEnvironment.keys()))
  }, 30_000)
  beat.unref?.()
  setTimeout(() => void queue.drive(), 5_000).unref?.()

  seam = service
  return {
    seam: service,
    cache,
    queue,
    capture,
    dispose() {
      clearInterval(beat)
      cache.flush()
      seam = null
      setArchiveCheckoutsProvider(null)
      for (const channel of Object.values(CH)) {
        ipcMain.removeHandler(channel)
      }
    }
  }
}

let current: CloudOfflineService | null = null
export function setCloudOfflineService(next: CloudOfflineService | null): void {
  current = next
}
/** Before a Sleep: snapshot every Orca Cloud workspace among `workspaceIds` (no-op otherwise). */
export async function captureCloudWorkspacesBeforeSleep(
  workspaceIds: readonly string[]
): Promise<void> {
  const service = current
  if (!service) {
    return
  }
  await Promise.all(workspaceIds.map((id) => service.capture(id).catch(() => undefined)))
}
