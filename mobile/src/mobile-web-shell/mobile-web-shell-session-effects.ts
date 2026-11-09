import { fetchMobileWebBundle } from '../transport/web-bundle/mobile-web-bundle-fetch'
import { mobileWebBundleManifestRead } from '../transport/web-bundle/mobile-web-bundle-operations'
import type {
  MobileWebBundleManifestRead,
  MobileWebBundleManifestReply
} from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import type { MobileWebBundleCompatManifest } from '../transport/web-bundle/mobile-web-bundle-compat'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { GenerationStore, StagedGeneration } from './generation-store'
import type { createShellPageDeadline } from './shell-page-deadline'
import {
  DOCUMENT_LOAD_DEADLINE_MS,
  PAGE_READY_DEADLINE_MS,
  type MobileWebShellRuntime
} from './mobile-web-shell-runtime'
import { generationDirectoryPath } from './generation-store-file-system'
import type {
  CachedGeneration,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'
import {
  updateFailureCauseOf,
  type MobileWebShellUpdateFailureCause
} from './mobile-web-shell-update-failure'

function compatOf(manifest: MobileWebBundleManifestRead): MobileWebBundleCompatManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    runtimeProtocolVersion: manifest.runtimeProtocolVersion,
    minCompatibleRuntimeProtocolVersion: manifest.minCompatibleRuntimeProtocolVersion,
    pageVersion: manifest.pageVersion
  }
}

export async function openCache(
  store: GenerationStore,
  hostKey: string
): Promise<CachedGeneration | null> {
  try {
    const active = await store.readActiveGeneration(hostKey)
    return active === null
      ? null
      : {
          buildId: active.buildId,
          directory: generationDirectoryPath(active.directory),
          totalBytes: active.manifest.totalBytes,
          routes: active.manifest.routes,
          compat: compatOf(active.manifest)
        }
  } catch {
    // Unreadable is not corrupt: leave cache intact and let connectivity decide download versus offline failure.
    return null
  }
}

const NO_CONNECTION: MobileWebShellUpdateFailureCause = { reason: 'no-connection', hostCode: null }
const CACHE_WRITE_FAILED: MobileWebShellUpdateFailureCause = {
  reason: 'cache-write-failed',
  hostCode: null
}

// Keep the reply before reporting it: the download the report starts reads windows from it instead of asking again.
export async function readManifest(
  client: RpcClient | null,
  flow: number,
  send: (event: MobileWebShellSessionEvent) => void,
  keep: (opened: MobileWebBundleManifestReply) => void
): Promise<void> {
  if (client === null) {
    send({ type: 'download-failed', flow, cause: NO_CONNECTION })
    return
  }
  let opened: MobileWebBundleManifestReply
  try {
    opened = await runRpcOperation(client, mobileWebBundleManifestRead, null)
  } catch (error) {
    send({ type: 'download-failed', flow, cause: updateFailureCauseOf(error) })
    return
  }
  const manifest = opened.manifest
  keep(opened)
  send({
    type: 'manifest-read',
    flow,
    manifest: {
      ...compatOf(manifest),
      buildId: manifest.buildId,
      totalBytes: manifest.totalBytes,
      totalAssets: manifest.assets.length,
      routes: manifest.routes
    }
  })
}

type FetchArgs = {
  client: RpcClient
  store: GenerationStore
  hostKey: string
  flow: number
  downloads: Set<AbortController>
  opened?: MobileWebBundleManifestReply
  send: (event: MobileWebShellSessionEvent) => void
}

// Fetch, verify and stage a build, then hand it to `land`; an abandoned screen stages nothing and hears nothing.
async function fetchAndStage(
  args: FetchArgs,
  foreground: boolean,
  land: (staged: StagedGeneration) => Promise<void>
): Promise<void> {
  const { client, store, hostKey, flow, send } = args
  const controller = new AbortController()
  args.downloads.add(controller)
  // After verified fetch, failures belong to local staging/commit.
  let fetchedWhole = false
  try {
    // Unavailable reuse is a cache miss, not a download failure.
    const reusable = await store.openReusableAssets(hostKey).catch(() => undefined)
    const fetched = await fetchMobileWebBundle({
      client,
      signal: controller.signal,
      ...(foreground
        ? { onProgress: (progress) => send({ type: 'fetch-progress', flow, ...progress }) }
        : {}),
      reusable,
      opened: args.opened
    })
    // Recheck abort after fetch’s last read so an abandoned screen cannot stage a generation.
    if (controller.signal.aborted) {
      return
    }
    fetchedWhole = true
    if (foreground) {
      send({ type: 'download-staged', flow })
    }
    const staged = await store.stageGeneration(hostKey, fetched, controller.signal, reusable)
    // Recheck after staging: abort may remove tmp, but cannot undo a commit’s activation/index changes.
    if (controller.signal.aborted) {
      await store.abortStagedGeneration(staged).catch(() => undefined)
      return
    }
    await land(staged)
  } catch (error) {
    if (!controller.signal.aborted) {
      send({
        type: 'download-failed',
        flow,
        cause: fetchedWhole ? CACHE_WRITE_FAILED : updateFailureCauseOf(error)
      })
    }
  } finally {
    args.downloads.delete(controller)
  }
}

export async function download(
  args: Omit<FetchArgs, 'client'> & {
    client: RpcClient | null
    runtime: MobileWebShellRuntime
    startedAt: number
  }
): Promise<void> {
  const { client, store, flow, runtime, send } = args
  if (client === null) {
    send({ type: 'download-failed', flow, cause: NO_CONNECTION })
    return
  }
  await fetchAndStage({ ...args, client }, true, async (staged) => {
    const committed = await store.commitGeneration(staged)
    send({
      type: 'activated',
      flow,
      generationDirectory: generationDirectoryPath(committed.directory),
      sessionId: runtime.mintSessionId(),
      buildId: committed.buildId,
      totalBytes: committed.manifest.totalBytes,
      elapsedMs: runtime.now() - args.startedAt
    })
  })
}

// Stage a newer build behind a running page and leave its commit to an entry with no readers.
export async function stageUpdate(
  args: Omit<FetchArgs, 'client'> & { client: RpcClient | null }
): Promise<void> {
  const { client, store, hostKey, flow, send, opened } = args
  if (client === null || opened === undefined) {
    send({ type: 'download-failed', flow, cause: NO_CONNECTION })
    return
  }
  // Wait out another page fetching it, and skip it once staged; restaging would rewrite the waiting tree.
  const leaving = new AbortController()
  args.downloads.add(leaving)
  const release = await store.claimUpdate(hostKey, opened.manifest.buildId)
  args.downloads.delete(leaving)
  if (release === null) {
    return
  }
  if (leaving.signal.aborted) {
    release()
    return
  }
  try {
    await fetchAndStage({ ...args, client }, false, async (staged) => store.deferCommit(staged))
  } finally {
    release()
  }
}

type ShellPageDeadline = ReturnType<typeof createShellPageDeadline>

export type FlowManifest = { readonly flow: number; readonly opened: MobileWebBundleManifestReply }

export type ShellEffectContext = {
  store: GenerationStore
  client: RpcClient | null
  hostId: string
  hostKey: string
  runtime: MobileWebShellRuntime
  flow: number
  startedAt: number
  // Abort abandoned downloads to release their four host read slots.
  downloads: Set<AbortController>
  // The one live page deadline; it counts only foreground time.
  deadline: ShellPageDeadline
  // The flow's manifest reply, so its download reads windows without asking for the manifest again.
  manifest: { current: FlowManifest | null }
  send: (event: MobileWebShellSessionEvent) => void
}

// Run one reducer effect; the caller's epoch fence keeps abandoned results out of a replacement session.
export async function runShellEffect(
  effect: MobileWebShellSessionEffect,
  context: ShellEffectContext
): Promise<void> {
  const { store, client, hostId, hostKey, runtime, flow, send } = context
  const held = context.manifest.current
  const opened = held?.flow === flow ? held.opened : undefined
  switch (effect.kind) {
    case 'delete-cache':
      // No completion event needed: the store queue orders the following sweep/read after deletion.
      await store.deleteHostCache(hostKey).catch(() => undefined)
      return
    case 'record-update-failure':
      // The runner owns host/time; best-effort store failures must not affect the decision.
      await store.recordUpdateFailure({ ...effect.failure, hostId, at: runtime.now() })
      return
    case 'forget-update-failures':
      await store.forgetHostUpdateFailures(hostId)
      return
    case 'open-cache':
      send({ type: 'cache-read', flow, generation: await openCache(store, hostKey) })
      return
    case 'read-manifest':
      await readManifest(client, flow, send, (reply) => {
        context.manifest.current = { flow, opened: reply }
      })
      return
    case 'download':
    case 'stage-update':
      // The reply has served its one download; a long-lived page should not keep its asset list.
      context.manifest.current = null
      await (effect.kind === 'download' ? download : stageUpdate)({ ...context, opened })
      return
    case 'open-generation':
      send({
        type: 'activated',
        flow,
        generationDirectory: effect.directory,
        sessionId: runtime.mintSessionId(),
        buildId: effect.buildId,
        totalBytes: effect.totalBytes,
        elapsedMs: runtime.now() - context.startedAt
      })
      return
    case 'remount': {
      const remount = (): void =>
        send({ type: 'remounted', flow, sessionId: runtime.mintSessionId() })
      // The dead document's deadlines are moot, so the remount can hold the one deadline slot.
      return effect.inForeground === true ? context.deadline.arm(0, remount) : remount()
    }
    case 'cancel-deadlines':
      context.deadline.cancel()
      return
    case 'await-page-ready':
      context.deadline.arm(PAGE_READY_DEADLINE_MS, () =>
        send({ type: 'page-ready-deadline', flow })
      )
      return
    case 'await-document-load':
      context.deadline.arm(DOCUMENT_LOAD_DEADLINE_MS, () =>
        send({ type: 'document-load-deadline', flow })
      )
  }
}
