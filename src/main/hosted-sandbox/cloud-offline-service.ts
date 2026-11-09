// Offline reading and wake on message for Orca Cloud workspaces:
// - answers to allowlisted read-only methods are kept (sealed) as the window reads them, and a
//   snapshot is read right before Sleep while terminals and chats are still up; the asleep view
//   shows that copy. Nothing is served to live panes as if it were current;
// - the queued-prompt store that wakes the VM (only when the person queues) and delivers once.
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { isEphemeralVmSuspended } from '../../shared/ephemeral-vm-environment-sleep'
import {
  ORCA_CLOUD_OFFLINE_CHANNELS as CH,
  type CloudOfflineSnapshot
} from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { RECIPE_VM_OPEN_HOLD_MS } from '../../shared/remote-runtime/recipe-vm-wake'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/runtime-environment-manual-disconnect'
import { getRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import {
  createCloudMessageQueue,
  type CloudMessageQueue,
  type WorkspaceAvailability
} from './cloud-message-queue'
import {
  createCloudOfflineCache,
  type CloudOfflineCache,
  type OfflineCacheCodec
} from './cloud-offline-cache'
import { setCloudOfflineReset } from './cloud-offline-reset'
import { safeStorageCodec, setCloudOfflineObserver } from './cloud-offline-seam'
import { archiveCheckoutsFromCache, buildOfflineSnapshot } from './cloud-offline-snapshot'
import { getHostedWorkspaceService, setArchiveCheckoutsProvider } from './hosted-workspace-service'

type CloudRuntimeInfo = {
  workspaceId: string
  environmentId: string
  asleep: boolean
  projectRoot: string | null
}

const CAPTURE_BUDGET_MS = 8_000
const MAX_CAPTURED_TERMINALS = 12

export type CloudOfflineService = {
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
  /** The control plane says the workspace is archived (nothing wakes or sends to it). */
  isArchived: (workspaceId: string) => Promise<boolean>
  codec?: OfflineCacheCodec | null
  log?: (line: string) => void
}): CloudOfflineService {
  const log = deps.log ?? ((line: string) => console.error(line))
  const codec = deps.codec === undefined ? safeStorageCodec() : deps.codec
  const cache = createCloudOfflineCache({
    root: join(deps.userDataPath, 'orca-cloud-offline'),
    codec
  })
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
    invalidate()
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

  async function locate(workspaceId: string): Promise<WorkspaceAvailability> {
    invalidate()
    const info = runtimes().byWorkspace.get(workspaceId)
    if (!info) {
      return { kind: 'gone' }
    }
    if (isRuntimeEnvironmentManuallyDisconnected(info.environmentId)) {
      return { kind: 'blocked', reason: 'This workspace was disconnected. Reconnect it to send.' }
    }
    if (!info.asleep) {
      return { kind: 'up', environmentId: info.environmentId }
    }
    if (await deps.isArchived(workspaceId).catch(() => false)) {
      return { kind: 'blocked', reason: 'This workspace is archived. Unarchive it to send.' }
    }
    return { kind: 'asleep', environmentId: info.environmentId }
  }

  const queue = createCloudMessageQueue({
    path: join(deps.userDataPath, 'orca-cloud-queued-prompts.bin'),
    codec,
    locate,
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

  setCloudOfflineObserver((environmentId, method, params, response) => {
    if (response.ok && runtimes().byEnvironment.has(environmentId)) {
      cache.record(environmentId, method, params, response)
    }
  })
  setCloudOfflineReset(() => {
    cache.clear()
    queue.clear()
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
    async (_event, args: { workspaceId: string; sessionId: string; text: string }) => {
      try {
        return { ok: true, prompt: await queue.enqueue(args) }
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

  // Background: deliver to VMs that are already up (never wakes), and drop removed workspaces.
  const beat = setInterval(() => {
    invalidate()
    void queue.drive()
    cache.prune(new Set(runtimes().byEnvironment.keys()))
  }, 30_000)
  beat.unref?.()
  const startup = setTimeout(() => void queue.drive(), 5_000)
  startup.unref?.()

  return {
    cache,
    queue,
    capture,
    dispose() {
      clearInterval(beat)
      clearTimeout(startup)
      cache.flush()
      setCloudOfflineObserver(null)
      setCloudOfflineReset(null)
      setArchiveCheckoutsProvider(null)
      for (const channel of Object.values(CH)) {
        ipcMain.removeHandler(channel)
      }
    }
  }
}

export {
  captureCloudWorkspacesBeforeSleep,
  failQueuedCloudPrompts,
  observeCloudOfflineAnswer,
  safeStorageCodec,
  setCloudOfflineService
} from './cloud-offline-seam'
